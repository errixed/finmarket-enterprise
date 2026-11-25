import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
    connectTestDatabase,
    disconnectTestDatabase,
    createTestContext,
    startServer,
    createAdvisor,
    createCampaign,
    ruleBody,
    randomObjectId,
    AutomationRule
} from "./helpers/automationTestKit.js";

// Guide section 8.3: rule validation, plus mass-assignment protection and
// the permitted trigger/action combinations.

describe("Automation rule validation", () => {
    let server;
    let advisor;
    let other;
    let campaign;
    let foreignCampaign;

    const create = (body, who = advisor) =>
        server.request("POST", "/automations", { token: who.token, body });
    const patch = (id, body, who = advisor) =>
        server.request("PATCH", `/automations/${id}`, { token: who.token, body });

    before(async () => {
        await connectTestDatabase("rules");
        server = await startServer(createTestContext().app);
        advisor = await createAdvisor("Owner");
        other = await createAdvisor("Other");
        campaign = await createCampaign({ advisorId: advisor.advisorId });
        foreignCampaign = await createCampaign({ advisorId: other.advisorId });
    });

    after(async () => {
        await server.close();
        await disconnectTestDatabase();
    });

    describe("creation", () => {
        test("a valid rule succeeds and applies defaults", async () => {
            const response = await create(ruleBody({ name: "  Defaults  " }));

            assert.equal(response.status, 201);
            assert.equal(response.body.data.name, "Defaults");
            assert.equal(response.body.data.enabled, false);
            assert.equal(response.body.data.delayMinutes, 0);
            assert.equal(response.body.data.campaignId, null);
            assert.equal(response.body.data.allowSpecialistToggle, false);
            assert.equal(response.body.data.executionCount, 0);
            assert.equal(response.body.data.__v, undefined, "internal fields are not exposed");
        });

        test("a rule with every supported field succeeds", async () => {
            const response = await create({
                name: "Follow up after consultation",
                description: "Send a follow-up one day later",
                trigger: "CONSULTATION_REQUESTED",
                action: "SCHEDULE_FOLLOW_UP",
                campaignId: campaign,
                delayMinutes: 1440,
                enabled: true,
                actionConfig: { subject: "Checking in", body: "Hello again" },
                allowSpecialistToggle: true
            });

            assert.equal(response.status, 201);
            assert.equal(response.body.data.campaignId, campaign);
            assert.equal(response.body.data.delayMinutes, 1440);
            assert.equal(response.body.data.actionConfig.subject, "Checking in");
        });

        test("missing required fields are rejected", async () => {
            const response = await create({});

            assert.equal(response.status, 400);
            assert.match(response.body.error.message, /name is required/);
            assert.match(response.body.error.message, /trigger is required/);
            assert.match(response.body.error.message, /action is required/);
        });

        test("invalid names and descriptions are rejected", async () => {
            for (const name of ["ab", "x".repeat(151), 42, "   "]) {
                assert.equal((await create(ruleBody({ name }))).status, 400, `name ${JSON.stringify(name)}`);
            }

            assert.equal((await create(ruleBody({ description: "d".repeat(1001) }))).status, 400);
        });

        test("invalid trigger and action values are rejected", async () => {
            const trigger = await create(ruleBody({ trigger: "NOT_A_TRIGGER" }));
            const action = await create(ruleBody({ action: "DELETE_EVERYTHING" }));
            const system = await create(ruleBody({ trigger: "AUTOMATION_EXECUTED" }));

            assert.equal(trigger.status, 400);
            assert.match(trigger.body.error.message, /trigger must be one of/);
            assert.equal(action.status, 400);
            assert.match(action.body.error.message, /action must be one of/);
            assert.equal(system.status, 400, "audit events can never be triggers");
        });

        test("invalid delay values are rejected", async () => {
            for (const delayMinutes of [-1, 1.5, "10", 43201, null, 1e9]) {
                const response = await create(ruleBody({ delayMinutes }));

                assert.equal(response.status, 400, `delay ${JSON.stringify(delayMinutes)}`);
                assert.match(response.body.error.message, /delayMinutes/);
            }

            assert.equal((await create(ruleBody({ delayMinutes: 0 }))).status, 201);
            assert.equal((await create(ruleBody({ delayMinutes: 43200 }))).status, 201);
        });

        test("invalid campaign references are rejected", async () => {
            const malformed = await create(ruleBody({ campaignId: "not-an-id" }));
            const missing = await create(ruleBody({ campaignId: randomObjectId() }));

            assert.equal(malformed.status, 400);
            assert.equal(missing.status, 404);
            assert.equal(missing.body.error.code, "CAMPAIGN_NOT_FOUND");
        });

        test("another advisor's campaign cannot be used", async () => {
            const before = await AutomationRule.countDocuments();
            const response = await create(ruleBody({ campaignId: foreignCampaign }));

            assert.equal(response.status, 403);
            assert.equal(response.body.error.code, "CAMPAIGN_ACCESS_DENIED");
            assert.equal(await AutomationRule.countDocuments(), before);
        });

        test("unsafe trigger/action combinations are rejected (loop guard)", async () => {
            const deliveryLoop = await create(ruleBody({
                trigger: "DELIVERY_QUEUED",
                action: "SEND_EMAIL",
                campaignId: campaign
            }));
            const campaignEmail = await create(ruleBody({
                trigger: "CAMPAIGN_ACTIVATED",
                action: "SEND_EMAIL",
                campaignId: campaign
            }));
            const followUpOnFailure = await create(ruleBody({
                trigger: "DELIVERY_FAILED",
                action: "SCHEDULE_FOLLOW_UP",
                campaignId: campaign
            }));

            for (const response of [deliveryLoop, campaignEmail, followUpOnFailure]) {
                assert.equal(response.status, 400);
                assert.match(response.body.error.message, /cannot be combined/);
            }

            const notify = await create(ruleBody({
                trigger: "DELIVERY_FAILED",
                action: "CREATE_NOTIFICATION"
            }));

            assert.equal(notify.status, 201, "delivery events may only create notifications");
        });

        test("a live email rule needs a campaign; a draft does not", async () => {
            const live = await create(ruleBody({ action: "SEND_EMAIL", enabled: true }));
            const draft = await create(ruleBody({ action: "SEND_EMAIL", enabled: false }));

            assert.equal(live.status, 400);
            assert.match(live.body.error.message, /campaignId is required/);
            assert.equal(draft.status, 201);
        });

        test("protected, internal and unknown fields cannot be set (mass assignment)", async () => {
            const before = await AutomationRule.countDocuments();

            for (const extra of [
                { lastExecutedAt: new Date().toISOString() },
                { executionCount: 99 },
                { createdAt: "2000-01-01T00:00:00.000Z" },
                { updatedAt: "2000-01-01T00:00:00.000Z" },
                { _id: randomObjectId() },
                { status: "COMPLETED" },
                { isAdmin: true },
                { "$set": { enabled: true } }
            ]) {
                const response = await create(ruleBody(extra));

                assert.equal(response.status, 400, JSON.stringify(extra));
            }

            assert.equal(await AutomationRule.countDocuments(), before, "nothing may be stored");
        });

        test("action configuration is validated", async () => {
            const tooLong = await create(ruleBody({ actionConfig: { subject: "s".repeat(201) } }));
            const unknown = await create(ruleBody({ actionConfig: { cc: "someone" } }));
            const notObject = await create(ruleBody({ actionConfig: "text" }));

            assert.equal(tooLong.status, 400);
            assert.equal(unknown.status, 400);
            assert.equal(notObject.status, 400);
        });

        test("malformed bodies are rejected", async () => {
            assert.equal((await create([])).status, 400);
            assert.equal((await create("text")).status, 400);

            const invalidJson = await fetch(`${server.base}/automations`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${advisor.token}` },
                body: "{not json"
            });

            assert.equal(invalidJson.status, 400);
        });
    });

    describe("updates", () => {
        let ruleId;

        before(async () => {
            ruleId = (await create(ruleBody({ name: "Update target", trigger: "LEAD_CREATED" }))).body.data._id;
        });

        test("allowed fields can be updated", async () => {
            const response = await patch(ruleId, {
                name: "Renamed",
                description: "New description",
                delayMinutes: 60,
                actionConfig: { subject: "S", body: "B" }
            });

            assert.equal(response.status, 200);
            assert.equal(response.body.data.name, "Renamed");
            assert.equal(response.body.data.delayMinutes, 60);
        });

        test("rules can be enabled and disabled", async () => {
            const on = await patch(ruleId, { enabled: true });
            const off = await patch(ruleId, { enabled: false });

            assert.equal(on.body.data.enabled, true);
            assert.equal(off.body.data.enabled, false);
        });

        test("protected fields cannot be changed", async () => {
            for (const body of [
                { ownerId: other.userId },
                { lastExecutedAt: new Date().toISOString() },
                { executionCount: 5 },
                { createdAt: "2000-01-01T00:00:00.000Z" },
                { _id: randomObjectId() }
            ]) {
                assert.equal((await patch(ruleId, body)).status, 400, JSON.stringify(body));
            }

            const stored = await AutomationRule.findById(ruleId).lean();

            assert.equal(String(stored.ownerId), advisor.userId);
            assert.equal(stored.lastExecutedAt, null);
            assert.equal(stored.executionCount, 0);
        });

        test("an empty update and invalid values are rejected", async () => {
            assert.equal((await patch(ruleId, {})).status, 400);
            assert.equal((await patch(ruleId, { delayMinutes: -5 })).status, 400);
            assert.equal((await patch(ruleId, { trigger: "NOPE" })).status, 400);
            assert.equal((await patch(ruleId, { enabled: "yes" })).status, 400);
        });

        test("the merged rule must still be a safe combination", async () => {
            const response = await patch(ruleId, { trigger: "DELIVERY_SENT", action: "SEND_EMAIL" });

            assert.equal(response.status, 400);

            const enableWithoutCampaign = await patch(
                (await create(ruleBody({ action: "SEND_EMAIL" }))).body.data._id,
                { enabled: true }
            );

            assert.equal(enableWithoutCampaign.status, 400);
        });

        test("changing to another advisor's campaign is rejected", async () => {
            const response = await patch(ruleId, { campaignId: foreignCampaign });

            assert.equal(response.status, 403);
            assert.equal((await AutomationRule.findById(ruleId).lean()).campaignId, null);
        });

        test("a campaign can be attached and detached", async () => {
            const attached = await patch(ruleId, { campaignId: campaign });
            const detached = await patch(ruleId, { campaignId: null });

            assert.equal(attached.body.data.campaignId, campaign);
            assert.equal(detached.body.data.campaignId, null);
        });

        test("rule updates enforce ownership", async () => {
            const response = await patch(ruleId, { name: "Not yours" }, other);

            assert.equal(response.status, 403);
            assert.notEqual((await AutomationRule.findById(ruleId).lean()).name, "Not yours");
        });

        test("a missing rule returns 404 and a malformed id returns 400", async () => {
            assert.equal((await patch(randomObjectId(), { name: "Nothing here" })).status, 404);
            assert.equal((await patch("not-an-id", { name: "Nothing here" })).status, 400);
            assert.equal(
                (await server.request("GET", `/automations/${randomObjectId()}`, { token: advisor.token })).status,
                404
            );
        });
    });

    describe("listing", () => {
        test("filters work and invalid filters are rejected", async () => {
            const enabled = await server.request("GET", "/automations?enabled=true&limit=100", { token: advisor.token });
            const byTrigger = await server.request("GET", "/automations?trigger=CONSULTATION_REQUESTED&limit=100", {
                token: advisor.token
            });

            assert.ok(enabled.body.data.every((rule) => rule.enabled === true));
            assert.ok(byTrigger.body.data.every((rule) => rule.trigger === "CONSULTATION_REQUESTED"));

            for (const query of [
                "trigger=NOPE",
                "action=NOPE",
                "enabled=maybe",
                "campaignId=bad",
                "unknown=1",
                "page=0",
                "limit=101",
                "limit=abc",
                "trigger=LEAD_CREATED&trigger=LEAD_STATUS_CHANGED",
                "enabled[$ne]=true"
            ]) {
                const response = await server.request("GET", `/automations?${query}`, { token: advisor.token });

                assert.equal(response.status, 400, query);
            }
        });

        test("pagination is stable: no gaps or repeats across pages", async () => {
            const fresh = await createAdvisor("Pager");

            for (let i = 1; i <= 5; i += 1) {
                await create(ruleBody({ name: `Paged rule ${i}` }), fresh);
            }

            const seen = [];
            let totalPages = 1;

            for (let page = 1; page <= totalPages; page += 1) {
                const response = await server.request("GET", `/automations?limit=2&page=${page}`, { token: fresh.token });

                totalPages = response.body.pagination.totalPages;
                assert.equal(response.body.pagination.total, 5);
                seen.push(...response.body.data.map((rule) => rule._id));
            }

            assert.equal(totalPages, 3);
            assert.equal(seen.length, 5);
            assert.equal(new Set(seen).size, 5);
        });
    });
});
