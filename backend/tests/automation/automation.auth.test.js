import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
    connectTestDatabase,
    disconnectTestDatabase,
    createTestContext,
    startServer,
    createAdvisor,
    createSpecialist,
    createAdmin,
    createCampaign,
    createAssignment,
    revokeAssignment,
    signToken,
    ruleBody,
    randomObjectId,
    AutomationRule,
    TEST_JWT_SECRET
} from "./helpers/automationTestKit.js";
import {
    resolveAuthenticate,
    failClosedAuthenticate
} from "../../src/modules/automation/automationAuth.js";
import errorHandler from "../../src/middleware/errorHandler.js";

// Guide section 8.2: authentication and authorization.
// The JWT helpers here stand in for Member 1's shared middleware (same
// req.auth contract); the checks under test are the Automation module's.

describe("Automation authentication and authorization", () => {
    let server;
    let advisorA;
    let advisorB;
    let admin;
    let specialist;          // accepted relationship + campaign assignment
    let relationshipOnly;    // accepted relationship, NOT assigned to the campaign
    let assignmentOnly;      // assigned to the campaign, relationship only PENDING
    let stranger;            // no relationship at all
    let relationship;
    let campaignA;
    let otherCampaignA;
    let ruleOnCampaign;
    let toggleableRule;
    let privateRule;
    let ruleB;

    const create = (who, body) =>
        server.request("POST", "/automations", { token: who.token, body });

    before(async () => {
        await connectTestDatabase("auth");
        server = await startServer(createTestContext().app);

        [advisorA, advisorB, admin, specialist, relationshipOnly, assignmentOnly, stranger] =
            await Promise.all([
                createAdvisor("A"),
                createAdvisor("B"),
                createAdmin(),
                createSpecialist("assigned"),
                createSpecialist("relationship-only"),
                createSpecialist("assignment-only"),
                createSpecialist("stranger")
            ]);

        relationship = await createAssignment({
            advisorId: advisorA.advisorId,
            specialistUserId: specialist.userId
        });
        await createAssignment({
            advisorId: advisorA.advisorId,
            specialistUserId: relationshipOnly.userId
        });
        await createAssignment({
            advisorId: advisorA.advisorId,
            specialistUserId: assignmentOnly.userId,
            status: "PENDING"
        });

        campaignA = await createCampaign({
            advisorId: advisorA.advisorId,
            assignedSpecialistIds: [specialist.userId, assignmentOnly.userId]
        });
        otherCampaignA = await createCampaign({ advisorId: advisorA.advisorId });

        ruleOnCampaign = (await create(advisorA, ruleBody({
            name: "Campaign rule",
            trigger: "CAMPAIGN_ACTIVATED",
            campaignId: campaignA
        }))).body.data;
        toggleableRule = (await create(advisorA, ruleBody({
            name: "Toggleable rule",
            trigger: "CAMPAIGN_ACTIVATED",
            campaignId: campaignA,
            allowSpecialistToggle: true
        }))).body.data;
        privateRule = (await create(advisorA, ruleBody({ name: "Private rule" }))).body.data;
        ruleB = (await create(advisorB, ruleBody({ name: "Advisor B rule" }))).body.data;

        // One campaign event the specialist may see, one lead event they may not.
        await server.request("POST", "/automations/simulate-event", {
            token: advisorA.token,
            body: { eventId: "evt_auth_campaign", eventType: "CAMPAIGN_ACTIVATED", entityId: campaignA }
        });
        await server.request("POST", "/automations/simulate-event", {
            token: advisorA.token,
            body: { eventId: "evt_auth_lead", eventType: "LEAD_CREATED" }
        });
    });

    after(async () => {
        await server.close();
        await disconnectTestDatabase();
    });

    describe("authentication", () => {
        const endpoints = [
            ["GET", "/automations"],
            ["POST", "/automations"],
            ["GET", "/automations/events"],
            ["GET", "/automations/executions"],
            ["POST", "/automations/simulate-event"],
            ["GET", `/automations/${randomObjectId()}`],
            ["PATCH", `/automations/${randomObjectId()}`],
            ["GET", "/analytics/summary"]
        ];

        test("a missing JWT is rejected on every endpoint", async () => {
            for (const [method, path] of endpoints) {
                const response = await server.request(method, path, { body: method === "GET" ? undefined : {} });

                assert.equal(response.status, 401, `${method} ${path}`);
                assert.equal(response.body.success, false);
            }
        });

        test("an invalid JWT is rejected", async () => {
            for (const token of ["garbage", "a.b.c", "Bearer", `${advisorA.token}tampered`]) {
                const response = await server.request("GET", "/automations", { token });

                assert.equal(response.status, 401, token);
            }

            const wrongSecret = signToken(
                { userId: advisorA.userId, role: "ADVISOR", advisorId: advisorA.advisorId },
                { secret: `${TEST_JWT_SECRET}-different` }
            );

            assert.equal(
                (await server.request("GET", "/automations", { token: wrongSecret })).status,
                401
            );
        });

        test("an expired JWT is rejected", async () => {
            const expired = signToken(
                { userId: advisorA.userId, role: "ADVISOR", advisorId: advisorA.advisorId },
                { expiresInSeconds: -60 }
            );
            const response = await server.request("GET", "/automations", { token: expired });

            assert.equal(response.status, 401);
        });

        test("without the shared middleware the module refuses requests (fail closed)", async () => {
            assert.equal(resolveAuthenticate({}), failClosedAuthenticate);

            const shared = () => {};

            assert.equal(resolveAuthenticate({ authenticate: shared }), shared);
            assert.equal(resolveAuthenticate({ default: shared }), shared);

            const app = express();

            app.use(failClosedAuthenticate);
            app.use(errorHandler);

            const closed = await startServer(app);

            try {
                const response = await closed.request("GET", "/anything");

                assert.equal(response.status, 503);
                assert.equal(response.body.error.code, "AUTH_UNAVAILABLE");
            } finally {
                await closed.close();
            }
        });
    });

    describe("advisor ownership", () => {
        test("an advisor can create their own rule; ownerId comes from the token", async () => {
            const response = await create(advisorA, ruleBody({ name: "Own rule" }));

            assert.equal(response.status, 201);
            assert.equal(response.body.data.ownerId, advisorA.userId);
        });

        test("a matching client-supplied ownerId is accepted", async () => {
            const response = await create(advisorA, ruleBody({ name: "Matching owner", ownerId: advisorA.userId }));

            assert.equal(response.status, 201);
            assert.equal(response.body.data.ownerId, advisorA.userId);
        });

        test("a client-supplied ownerId cannot override authenticated ownership", async () => {
            const before = await AutomationRule.countDocuments();
            const response = await create(advisorA, ruleBody({ name: "Spoofed owner", ownerId: advisorB.userId }));

            assert.equal(response.status, 403);
            assert.equal(response.body.error.code, "OWNER_MISMATCH");
            assert.equal(await AutomationRule.countDocuments(), before, "nothing may be stored");
        });

        test("only advisors can create rules (specialists and admins cannot)", async () => {
            assert.equal((await create(specialist, ruleBody())).status, 403);
            assert.equal((await create(admin, ruleBody())).status, 403);
        });

        test("an advisor cannot modify or read another advisor's rule", async () => {
            const patch = await server.request("PATCH", `/automations/${ruleB._id}`, {
                token: advisorA.token,
                body: { name: "Hijacked", enabled: true }
            });
            const read = await server.request("GET", `/automations/${ruleB._id}`, { token: advisorA.token });

            assert.equal(patch.status, 403);
            assert.equal(read.status, 403);
            assert.equal((await AutomationRule.findById(ruleB._id).lean()).name, "Advisor B rule");
        });

        test("listing returns only the caller's rules and refuses other owners", async () => {
            const own = await server.request("GET", "/automations?limit=100", { token: advisorB.token });

            assert.ok(own.body.data.length >= 1);
            assert.ok(own.body.data.every((rule) => rule.ownerId === advisorB.userId));

            const other = await server.request("GET", `/automations?ownerId=${advisorA.userId}`, {
                token: advisorB.token
            });

            assert.equal(other.status, 403);
        });

        test("events and executions are limited to the owner", async () => {
            const events = await server.request("GET", "/automations/events?limit=100", { token: advisorB.token });
            const executions = await server.request("GET", "/automations/executions", { token: advisorB.token });

            assert.equal(events.status, 200);
            assert.ok(events.body.data.every((event) => event.ownerId === advisorB.userId));
            assert.ok(executions.body.data.every((item) => item.ownerId === advisorB.userId));
        });

        test("the owner of a rule cannot be changed", async () => {
            const response = await server.request("PATCH", `/automations/${privateRule._id}`, {
                token: advisorA.token,
                body: { ownerId: advisorB.userId }
            });

            assert.equal(response.status, 400);
            assert.equal((await AutomationRule.findById(privateRule._id).lean()).ownerId.toString(), advisorA.userId);
        });
    });

    describe("marketing specialists", () => {
        test("a specialist with no relationship sees nothing", async () => {
            const rules = await server.request("GET", "/automations", { token: stranger.token });
            const events = await server.request("GET", "/automations/events", { token: stranger.token });
            const direct = await server.request("GET", `/automations/${ruleOnCampaign._id}`, { token: stranger.token });

            assert.equal(rules.status, 200);
            assert.deepEqual(rules.body.data, []);
            assert.deepEqual(events.body.data, []);
            assert.equal(direct.status, 403);
        });

        test("an accepted relationship alone does not grant access", async () => {
            const rules = await server.request("GET", "/automations", { token: relationshipOnly.token });
            const events = await server.request("GET", "/automations/events", { token: relationshipOnly.token });

            assert.deepEqual(rules.body.data, []);
            assert.deepEqual(events.body.data, []);
        });

        test("a campaign assignment alone does not grant access (relationship not accepted)", async () => {
            const rules = await server.request("GET", "/automations", { token: assignmentOnly.token });

            assert.deepEqual(rules.body.data, []);
        });

        test("relationship AND assignment grant access to campaign rules only", async () => {
            const rules = await server.request("GET", "/automations?limit=100", { token: specialist.token });
            const ids = rules.body.data.map((rule) => rule._id);

            assert.equal(rules.status, 200);
            assert.ok(ids.includes(ruleOnCampaign._id));
            assert.ok(ids.includes(toggleableRule._id));
            assert.ok(!ids.includes(privateRule._id), "a rule without a campaign is private");
            assert.ok(!ids.includes(ruleB._id), "another advisor's rule is never visible");
            assert.ok(rules.body.data.every((rule) => [campaignA].includes(rule.campaignId)));

            const direct = await server.request("GET", `/automations/${privateRule._id}`, { token: specialist.token });

            assert.equal(direct.status, 403);
        });

        test("a specialist only sees events about their assigned campaigns", async () => {
            const events = await server.request("GET", "/automations/events?limit=100", { token: specialist.token });
            const ids = events.body.data.map((event) => event.eventId);

            assert.ok(ids.includes("evt_auth_campaign"));
            assert.ok(!ids.includes("evt_auth_lead"));
        });

        test("a specialist cannot create rules or simulate events", async () => {
            assert.equal((await create(specialist, ruleBody({ campaignId: campaignA }))).status, 403);

            const simulate = await server.request("POST", "/automations/simulate-event", {
                token: specialist.token,
                body: { eventType: "LEAD_CREATED" }
            });

            assert.equal(simulate.status, 403);
        });

        test("a specialist cannot change a rule unless the owner explicitly allowed it", async () => {
            const denied = await server.request("PATCH", `/automations/${ruleOnCampaign._id}`, {
                token: specialist.token,
                body: { enabled: true }
            });

            assert.equal(denied.status, 403);
            assert.equal((await AutomationRule.findById(ruleOnCampaign._id).lean()).enabled, false);
        });

        test("with explicit permission a specialist may switch a rule on and off, nothing else", async () => {
            const on = await server.request("PATCH", `/automations/${toggleableRule._id}`, {
                token: specialist.token,
                body: { enabled: true }
            });
            const off = await server.request("PATCH", `/automations/${toggleableRule._id}`, {
                token: specialist.token,
                body: { enabled: false }
            });
            const rename = await server.request("PATCH", `/automations/${toggleableRule._id}`, {
                token: specialist.token,
                body: { name: "Renamed by specialist" }
            });
            const escalate = await server.request("PATCH", `/automations/${toggleableRule._id}`, {
                token: specialist.token,
                body: { enabled: true, allowSpecialistToggle: false }
            });

            assert.equal(on.status, 200);
            assert.equal(on.body.data.enabled, true);
            assert.equal(off.status, 200);
            assert.equal(rename.status, 403);
            assert.equal(escalate.status, 403);
            assert.equal((await AutomationRule.findById(toggleableRule._id).lean()).name, "Toggleable rule");
        });

        test("a rule on a campaign the specialist is not assigned to cannot be toggled", async () => {
            const unassignedRule = (await create(advisorA, ruleBody({
                name: "Other campaign rule",
                trigger: "CAMPAIGN_ACTIVATED",
                campaignId: otherCampaignA,
                allowSpecialistToggle: true
            }))).body.data;
            const response = await server.request("PATCH", `/automations/${unassignedRule._id}`, {
                token: specialist.token,
                body: { enabled: true }
            });

            assert.equal(response.status, 403);
        });

        test("revoking the relationship removes the specialist's access immediately", async () => {
            const before = await server.request("GET", `/automations/${toggleableRule._id}`, { token: specialist.token });

            assert.equal(before.status, 200);

            await revokeAssignment(relationship);

            const rules = await server.request("GET", "/automations", { token: specialist.token });
            const read = await server.request("GET", `/automations/${toggleableRule._id}`, { token: specialist.token });
            const toggle = await server.request("PATCH", `/automations/${toggleableRule._id}`, {
                token: specialist.token,
                body: { enabled: true }
            });
            const events = await server.request("GET", "/automations/events", { token: specialist.token });

            assert.deepEqual(rules.body.data, []);
            assert.equal(read.status, 403);
            assert.equal(toggle.status, 403);
            assert.deepEqual(events.body.data, []);
        });
    });

    describe("administrators", () => {
        test("an administrator has read-only oversight", async () => {
            const rules = await server.request("GET", "/automations?limit=100", { token: admin.token });
            const owners = new Set(rules.body.data.map((rule) => rule.ownerId));

            assert.equal(rules.status, 200);
            assert.ok(owners.has(advisorA.userId) && owners.has(advisorB.userId));

            const patch = await server.request("PATCH", `/automations/${ruleB._id}`, {
                token: admin.token,
                body: { enabled: true }
            });
            const simulate = await server.request("POST", "/automations/simulate-event", {
                token: admin.token,
                body: { eventType: "LEAD_CREATED", ownerId: advisorB.userId }
            });

            assert.equal(patch.status, 403, "no ownership bypass for changes");
            assert.equal(simulate.status, 403, "an admin cannot trigger an advisor's rules");
        });
    });

    describe("analytics access", () => {
        test("private analytics need authentication", async () => {
            assert.equal((await server.request("GET", "/analytics/summary")).status, 401);
        });

        test("an advisor's analytics only count their own resources", async () => {
            const a = await server.request("GET", "/analytics/summary", { token: advisorA.token });
            const b = await server.request("GET", "/analytics/summary", { token: advisorB.token });

            assert.equal(a.status, 200);
            assert.equal(b.status, 200);

            const ownRulesA = await AutomationRule.countDocuments({ ownerId: advisorA.userId });
            const ownRulesB = await AutomationRule.countDocuments({ ownerId: advisorB.userId });

            assert.equal(a.body.data.rules.total, ownRulesA);
            assert.equal(b.body.data.rules.total, ownRulesB);
            assert.equal(a.body.data.scope.level, "OWN_RESOURCES");
        });

        test("a specialist without access gets empty analytics and no lead data", async () => {
            const response = await server.request("GET", "/analytics/summary", { token: stranger.token });

            assert.equal(response.status, 200);
            assert.equal(response.body.data.rules.total, 0);
            assert.equal(response.body.data.events.total, 0);
            assert.equal(response.body.data.business.leads, null);
            assert.equal(response.body.data.scope.level, "ASSIGNED_CAMPAIGNS");
        });
    });
});
