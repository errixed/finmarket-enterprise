import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
    connectTestDatabase,
    disconnectTestDatabase,
    createTestContext,
    createMockDelivery,
    startServer,
    createAdvisor,
    createSpecialist,
    createCampaign,
    createLead,
    createDeliveryJob,
    ruleBody,
    randomObjectId,
    ActivityEvent,
    AutomationExecution,
    AutomationRule
} from "./helpers/automationTestKit.js";
import { SAMPLE_LEAD_ID } from "../../src/modules/automation/automationConstants.js";

// Guide section 8.4 (event processing) and 5.10 (event history), plus the
// metadata safety requirements and the shared event contract (8.8).

describe("Automation event processing", () => {
    let delivery;
    let context;
    let server;
    let advisor;
    let other;
    let campaign;
    let otherCampaign;
    let foreignCampaign;

    const createRule = async (body, who = advisor) => {
        const response = await server.request("POST", "/automations", { token: who.token, body });

        assert.equal(response.status, 201, JSON.stringify(response.body));

        return response.body.data;
    };

    const simulate = (body, who = advisor) =>
        server.request("POST", "/automations/simulate-event", { token: who.token, body });

    before(async () => {
        await connectTestDatabase("events");

        delivery = createMockDelivery();
        context = createTestContext({ delivery });
        server = await startServer(context.app);

        advisor = await createAdvisor("Owner");
        other = await createAdvisor("Other");
        campaign = await createCampaign({ advisorId: advisor.advisorId });
        otherCampaign = await createCampaign({ advisorId: advisor.advisorId });
        foreignCampaign = await createCampaign({ advisorId: other.advisorId });
    });

    after(async () => {
        await server.close();
        await disconnectTestDatabase();
    });

    describe("simulated events", () => {
        test("a valid event is persisted and matching enabled rules are identified", async () => {
            const rule = await createRule(ruleBody({
                name: "Match me",
                trigger: "CONSULTATION_REQUESTED",
                action: "CREATE_NOTIFICATION",
                delayMinutes: 60,
                enabled: true
            }));

            const response = await simulate({
                eventId: "evt_match_001",
                eventType: "CONSULTATION_REQUESTED"
            });

            assert.equal(response.status, 201);

            const { event, simulatedActions } = response.body.data;

            assert.equal(event.eventId, "evt_match_001");
            assert.equal(event.ownerId, advisor.userId);
            assert.equal(event.source, "SIMULATION");
            assert.equal(event.processingStatus, "PROCESSED");
            assert.equal(event.matchedRuleCount, 1);
            assert.equal(simulatedActions.length, 1);

            // Same keys as the Phase I response.
            assert.deepEqual(Object.keys(simulatedActions[0]).sort(), [
                "action", "delayMinutes", "ruleId", "ruleName", "scheduledFor", "status"
            ]);
            assert.equal(simulatedActions[0].ruleId, rule._id);
            assert.equal(simulatedActions[0].status, "SIMULATED");
            assert.equal(simulatedActions[0].delayMinutes, 60);

            const scheduled = new Date(simulatedActions[0].scheduledFor).getTime();
            const occurred = new Date(event.occurredAt).getTime();

            assert.equal(scheduled - occurred, 60 * 60 * 1000, "scheduledFor = occurredAt + delay");
        });

        test("an event with no matching rule is stored and handled", async () => {
            const response = await simulate({ eventId: "evt_nomatch_001", eventType: "LEAD_STATUS_CHANGED" });

            assert.equal(response.status, 201);
            assert.deepEqual(response.body.data.simulatedActions, []);
            assert.equal(response.body.data.event.matchedRuleCount, 0);
            assert.equal(response.body.data.event.processingStatus, "PROCESSED");
            assert.ok(await ActivityEvent.exists({ eventId: "evt_nomatch_001" }));
        });

        test("disabled rules are ignored", async () => {
            await createRule(ruleBody({ name: "Disabled", trigger: "CAMPAIGN_CREATED", enabled: false }));

            const response = await simulate({
                eventId: "evt_disabled_001",
                eventType: "CAMPAIGN_CREATED",
                entityId: campaign
            });

            assert.equal(response.status, 201);
            assert.deepEqual(response.body.data.simulatedActions, []);
        });

        test("rules belonging to another advisor never match", async () => {
            await createRule(ruleBody({
                name: "Other advisor rule",
                trigger: "LEAD_CREATED",
                enabled: true
            }), other);

            const response = await simulate({ eventId: "evt_scope_001", eventType: "LEAD_CREATED" });

            assert.ok(response.body.data.simulatedActions.every(
                (action) => action.ruleName !== "Other advisor rule"
            ));
        });

        test("a campaign-specific rule only matches events about that campaign", async () => {
            const rule = await createRule(ruleBody({
                name: "Campaign specific",
                trigger: "CAMPAIGN_ACTIVATED",
                campaignId: campaign,
                enabled: true
            }));

            const matching = await simulate({
                eventId: "evt_campaign_match",
                eventType: "CAMPAIGN_ACTIVATED",
                entityId: campaign
            });
            const different = await simulate({
                eventId: "evt_campaign_other",
                eventType: "CAMPAIGN_ACTIVATED",
                entityId: otherCampaign
            });

            assert.ok(matching.body.data.simulatedActions.some((action) => action.ruleId === rule._id));
            assert.ok(different.body.data.simulatedActions.every((action) => action.ruleId !== rule._id));
        });

        test("with no body it simulates the Phase I sample LEAD_CREATED event", async () => {
            const response = await simulate(undefined);

            assert.equal(response.status, 201);
            assert.equal(response.body.data.event.eventType, "LEAD_CREATED");
            assert.equal(response.body.data.event.entityType, "LEAD");
            assert.equal(response.body.data.event.entityId, SAMPLE_LEAD_ID);
            assert.match(response.body.data.event.eventId, /^evt_/);
        });

        test("simulated events never call the delivery adapter", async () => {
            await createRule(ruleBody({
                name: "Would send email",
                trigger: "LEAD_STATUS_CHANGED",
                action: "SEND_EMAIL",
                campaignId: campaign,
                enabled: true
            }));
            delivery.calls.length = 0;

            const response = await simulate({
                eventId: "evt_noprovider_001",
                eventType: "LEAD_STATUS_CHANGED",
                metadata: { campaignId: campaign }
            });

            assert.equal(response.status, 201);
            assert.equal(response.body.data.simulatedActions.length, 1);
            assert.equal(response.body.data.simulatedActions[0].status, "SIMULATED");
            assert.equal(delivery.calls.length, 0, "a simulation must not reach Delivery");

            // The worker never picks simulated executions up either.
            const summary = await context.service.processDueExecutions();

            assert.equal(delivery.calls.length, 0);
            assert.equal(summary.claimed, 0);

            const execution = await AutomationExecution.findOne({ eventId: "evt_noprovider_001" }).lean();

            assert.equal(execution.simulated, true);
            assert.equal(execution.status, "SIMULATED");
            assert.equal(execution.attemptCount, 0);
        });
    });

    describe("validation and ownership", () => {
        test("invalid event types are rejected", async () => {
            for (const eventType of ["BOGUS", "", 42, "AUTOMATION_EXECUTED", "AUTOMATION_FAILED"]) {
                const response = await simulate({ eventId: `evt_type_${Math.random()}`.slice(0, 20), eventType });

                assert.equal(response.status, 400, String(eventType));
                assert.match(response.body.error.message, /eventType/);
            }
        });

        test("entity type must match the event type", async () => {
            const response = await simulate({ eventType: "LEAD_CREATED", entityType: "CAMPAIGN" });

            assert.equal(response.status, 400);
            assert.match(response.body.error.message, /does not match eventType/);

            assert.equal((await simulate({ eventType: "LEAD_CREATED", entityType: "NOPE" })).status, 400);
        });

        test("malformed identifiers and unknown fields are rejected", async () => {
            for (const body of [
                { entityId: "not-an-id" },
                { ownerId: "not-an-id" },
                { eventId: "has spaces" },
                { eventId: "x".repeat(101) },
                { eventId: 12345 },
                { source: "INTERNAL" },
                { processingStatus: "PROCESSED" },
                { occurredAt: "2020-01-01T00:00:00.000Z" },
                { matchedRuleCount: 5 },
                { campaignId: campaign }
            ]) {
                const response = await simulate(body);

                assert.equal(response.status, 400, JSON.stringify(body));
            }
        });

        test("references to missing or foreign entities are rejected", async () => {
            const missingCampaign = await simulate({ eventType: "CAMPAIGN_ACTIVATED", entityId: randomObjectId() });
            const foreign = await simulate({ eventType: "CAMPAIGN_ACTIVATED", entityId: foreignCampaign });
            const foreignLead = await createLead({ advisorId: other.advisorId });
            const lead = await simulate({ eventType: "LEAD_CREATED", entityId: foreignLead });
            const ownLead = await simulate({
                eventType: "LEAD_CREATED",
                entityId: await createLead({ advisorId: advisor.advisorId })
            });
            const metadataCampaign = await simulate({
                eventType: "LEAD_CREATED",
                metadata: { campaignId: foreignCampaign }
            });

            assert.equal(missingCampaign.status, 404);
            assert.equal(foreign.status, 403);
            assert.equal(lead.status, 403, "an existing lead of another advisor is rejected");
            assert.equal(ownLead.status, 201);
            assert.equal(metadataCampaign.status, 403, "events cannot be attached to someone else's campaign");
        });

        test("event ownership is verified: another owner's rules cannot be triggered", async () => {
            const before = await ActivityEvent.countDocuments();
            const response = await simulate({ eventType: "LEAD_CREATED", ownerId: other.userId });

            assert.equal(response.status, 403);
            assert.equal(response.body.error.code, "OWNER_MISMATCH");
            assert.equal(await ActivityEvent.countDocuments(), before, "nothing may be stored");
        });

        test("simulation is disabled in production unless explicitly enabled", async () => {
            const production = createTestContext({ env: { NODE_ENV: "production" } });
            const enabled = createTestContext({
                env: { NODE_ENV: "production", AUTOMATION_SIMULATION_ENABLED: "true" }
            });
            const closed = await startServer(production.app);
            const open = await startServer(enabled.app);

            try {
                const denied = await closed.request("POST", "/automations/simulate-event", {
                    token: advisor.token,
                    body: { eventType: "LEAD_STATUS_CHANGED" }
                });
                const allowed = await open.request("POST", "/automations/simulate-event", {
                    token: advisor.token,
                    body: { eventType: "LEAD_STATUS_CHANGED" }
                });

                assert.equal(denied.status, 403);
                assert.equal(denied.body.error.code, "SIMULATION_DISABLED");
                assert.equal(allowed.status, 201);
            } finally {
                await closed.close();
                await open.close();
            }
        });
    });

    describe("event metadata safety", () => {
        test("benign metadata is stored", async () => {
            const response = await simulate({
                eventId: "evt_meta_ok",
                eventType: "LEAD_STATUS_CHANGED",
                metadata: { previousStatus: "NEW", newStatus: "CONTACTED", score: 7, tags: ["warm"], flag: true }
            });

            assert.equal(response.status, 201);
            assert.equal(response.body.data.event.metadata.newStatus, "CONTACTED");
        });

        test("credentials and personal contact data are rejected", async () => {
            const bad = [
                { password: "hunter2" },
                { userPassword: "hunter2" },
                { jwt: "x" },
                { accessToken: "abc" },
                { Authorization: "Bearer abc" },
                { apiKey: "k" },
                { secret: "s" },
                { email: "person@example.com" },
                { phoneNumber: "555-0100" },
                { note: "contact person@example.com" },
                { header: "Bearer abcdef" },
                { value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl" },
                { nested: { deeper: { password: "x" } } },
                { $where: "1" },
                { "a.b": 1 },
                { list: [{ token: "t" }] }
            ];

            for (const metadata of bad) {
                const response = await simulate({
                    eventId: `evt_meta_${Math.random().toString(36).slice(2, 10)}`,
                    eventType: "LEAD_STATUS_CHANGED",
                    metadata
                });

                assert.equal(response.status, 400, JSON.stringify(metadata));
                assert.equal(response.body.error.code, "METADATA_NOT_ALLOWED");
                assert.doesNotMatch(
                    JSON.stringify(response.body),
                    /hunter2|person@example\.com|eyJhbGci/,
                    "the rejected value must not be echoed back"
                );
            }
        });

        test("oversized or too deeply nested metadata is rejected", async () => {
            const tooBig = { text: "x".repeat(400), more: Array.from({ length: 40 }, (_, i) => `value-${i}-${"y".repeat(100)}`) };
            const tooDeep = { a: { b: { c: { d: 1 } } } };

            for (const metadata of [tooBig, tooDeep, "text", ["array"]]) {
                const response = await simulate({
                    eventId: `evt_size_${Math.random().toString(36).slice(2, 10)}`,
                    eventType: "LEAD_STATUS_CHANGED",
                    metadata
                });

                assert.equal(response.status, 400);
            }
        });

        test("sensitive keys already in the database are redacted when read", async () => {
            await ActivityEvent.collection.insertOne({
                eventId: "evt_legacy_secret",
                eventType: "LEAD_STATUS_CHANGED",
                entityType: "LEAD",
                entityId: new (await import("mongoose")).default.Types.ObjectId(),
                ownerId: new (await import("mongoose")).default.Types.ObjectId(advisor.userId),
                occurredAt: new Date(),
                source: "INTERNAL",
                processingStatus: "PROCESSED",
                matchedRuleCount: 0,
                metadata: { safe: "visible", password: "leaked", nested: { apiKey: "leaked-too" } },
                createdAt: new Date(),
                updatedAt: new Date()
            });

            const response = await server.request("GET", "/automations/events?limit=100", { token: advisor.token });
            const event = response.body.data.find((item) => item.eventId === "evt_legacy_secret");

            assert.ok(event);
            assert.equal(event.metadata.safe, "visible");
            assert.doesNotMatch(JSON.stringify(event), /leaked/);
        });
    });

    describe("trusted events from other modules (mock event sources)", () => {
        let lead;
        let welcomeRule;
        let followUpRule;
        let notifyRule;

        before(async () => {
            lead = await createLead({ advisorId: advisor.advisorId });
            welcomeRule = await createRule(ruleBody({
                name: "Welcome email on lead creation",
                trigger: "LEAD_CREATED",
                action: "SEND_EMAIL",
                campaignId: campaign,
                enabled: true,
                actionConfig: { subject: "Welcome!", body: "Glad you are here." }
            }));
            notifyRule = await createRule(ruleBody({
                name: "Notify on activation",
                trigger: "CAMPAIGN_ACTIVATED",
                action: "CREATE_NOTIFICATION",
                campaignId: otherCampaign,
                enabled: true
            }));
            followUpRule = await createRule(ruleBody({
                name: "Notify when delivery queued",
                trigger: "DELIVERY_QUEUED",
                action: "CREATE_NOTIFICATION",
                enabled: true
            }));
        });

        test("a Lead event runs the email action through the Delivery adapter", async () => {
            delivery.calls.length = 0;

            const result = await context.service.publishEvent({
                eventId: "evt_lead_created_001",
                eventType: "LEAD_CREATED",
                entityType: "LEAD",
                entityId: lead,
                ownerId: advisor.userId,
                metadata: { campaignId: campaign }
            });

            assert.equal(result.duplicate, false);
            assert.equal(result.event.source, "INTERNAL");
            assert.equal(result.event.processingStatus, "PROCESSED");

            const run = result.executions.find((item) => String(item.execution.automationRuleId) === welcomeRule._id);

            assert.equal(run.execution.status, "COMPLETED");
            assert.ok(run.execution.result.deliveryJobId);
            assert.equal(delivery.calls.length, 1);

            const request = delivery.calls[0];

            assert.equal(request.idempotencyKey, `evt_lead_created_001:${welcomeRule._id}`);
            assert.equal(request.advisorId, advisor.advisorId, "advisorId is the AdvisorProfile id");
            assert.equal(request.campaignId, campaign);
            assert.equal(request.leadId, lead);
            assert.equal(request.channel, "EMAIL");
            assert.equal(request.source, "AUTOMATION");
            assert.deepEqual(request.content, { subject: "Welcome!", body: "Glad you are here." });

            const stored = await AutomationRule.findById(welcomeRule._id).lean();

            assert.equal(stored.executionCount, 1);
            assert.ok(stored.lastExecutedAt);
        });

        test("a successful action writes an audit event that cannot trigger anything", async () => {
            const audit = await ActivityEvent.findOne({
                eventType: "AUTOMATION_EXECUTED",
                "metadata.sourceEventId": "evt_lead_created_001"
            }).lean();

            assert.ok(audit, "AUTOMATION_EXECUTED audit event");
            assert.equal(audit.entityType, "AUTOMATION_RULE");
            assert.equal(String(audit.entityId), welcomeRule._id);

            // The audit event matched nothing and created no further work.
            assert.equal(audit.matchedRuleCount, 0);
            assert.equal(await AutomationExecution.countDocuments({ eventId: audit.eventId }), 0);

            // And it cannot be published as a trigger.
            await assert.rejects(
                () => context.service.publishEvent({
                    eventId: "evt_try_audit",
                    eventType: "AUTOMATION_EXECUTED",
                    entityType: "AUTOMATION_RULE",
                    entityId: welcomeRule._id,
                    ownerId: advisor.userId
                }),
                { statusCode: 400 }
            );
        });

        test("a Campaign event runs a notification without calling Delivery", async () => {
            delivery.calls.length = 0;

            const result = await context.service.publishEvent({
                eventId: "evt_campaign_activated_001",
                eventType: "CAMPAIGN_ACTIVATED",
                entityType: "CAMPAIGN",
                entityId: otherCampaign,
                ownerId: advisor.userId
            });
            const run = result.executions.find((item) => String(item.execution.automationRuleId) === notifyRule._id);

            assert.equal(run.execution.status, "COMPLETED");
            assert.deepEqual(run.execution.result, { notification: "RECORDED" });
            assert.equal(delivery.calls.length, 0);
            assert.equal(String(result.event.campaignId), otherCampaign, "campaignId is derived for campaign events");
        });

        test("a Delivery event can only trigger notifications (no delivery loop)", async () => {
            delivery.calls.length = 0;

            const job = await createDeliveryJob({ advisorId: advisor.advisorId, campaignId: campaign });
            const before = await ActivityEvent.countDocuments({ eventType: { $in: ["DELIVERY_QUEUED"] } });
            const result = await context.service.publishEvent({
                eventId: "evt_delivery_queued_001",
                eventType: "DELIVERY_QUEUED",
                entityType: "DELIVERY",
                entityId: job,
                ownerId: advisor.userId,
                metadata: { campaignId: campaign }
            });

            assert.equal(result.event.entityType, "DELIVERY_JOB", "DELIVERY is stored as DELIVERY_JOB");
            assert.equal(String(result.event.campaignId), campaign);
            assert.equal(delivery.calls.length, 0, "a delivery event must not queue another delivery");

            const ran = result.executions.map((item) => item.execution.action);

            assert.deepEqual(ran, ["CREATE_NOTIFICATION"]);
            assert.equal(
                await ActivityEvent.countDocuments({ eventType: "DELIVERY_QUEUED" }),
                before + 1
            );
            assert.ok(followUpRule);
        });

        test("the owner must be an active advisor and the entity must exist", async () => {
            const specialist = await createSpecialist();

            for (const [ownerId, expected] of [
                [randomObjectId(), 400],
                [specialist.userId, 400]
            ]) {
                await assert.rejects(
                    () => context.service.publishEvent({
                        eventId: `evt_owner_${ownerId.slice(-6)}`,
                        eventType: "LEAD_CREATED",
                        entityId: lead,
                        ownerId
                    }),
                    { statusCode: expected, code: "INVALID_OWNER" }
                );
            }

            await assert.rejects(
                () => context.service.publishEvent({
                    eventId: "evt_missing_lead",
                    eventType: "LEAD_CREATED",
                    entityId: randomObjectId(),
                    ownerId: advisor.userId
                }),
                { statusCode: 404, code: "ENTITY_NOT_FOUND" }
            );

            const foreignLeadId = await createLead({ advisorId: other.advisorId });

            await assert.rejects(
                () => context.service.publishEvent({
                    eventId: "evt_foreign_lead",
                    eventType: "LEAD_CREATED",
                    entityId: foreignLeadId,
                    ownerId: advisor.userId
                }),
                { statusCode: 403, code: "ENTITY_ACCESS_DENIED" }
            );
        });

        test("trusted events may carry their original occurrence time but not the future", async () => {
            const past = await context.service.publishEvent({
                eventId: "evt_past_001",
                eventType: "LEAD_STATUS_CHANGED",
                entityId: lead,
                ownerId: advisor.userId,
                occurredAt: "2026-01-15T10:00:00.000Z"
            });

            assert.equal(new Date(past.event.occurredAt).toISOString(), "2026-01-15T10:00:00.000Z");

            await assert.rejects(
                () => context.service.publishEvent({
                    eventId: "evt_future_001",
                    eventType: "LEAD_STATUS_CHANGED",
                    entityId: lead,
                    ownerId: advisor.userId,
                    occurredAt: new Date(Date.now() + 3600_000).toISOString()
                }),
                { statusCode: 400 }
            );
        });
    });

    describe("event history", () => {
        let historyAdvisor;

        before(async () => {
            historyAdvisor = await createAdvisor("History");

            const lead = await createLead({ advisorId: historyAdvisor.advisorId });
            const historyCampaign = await createCampaign({ advisorId: historyAdvisor.advisorId });
            const publish = (eventId, eventType, extra = {}) =>
                context.service.publishEvent({
                    eventId,
                    eventType,
                    entityId: eventType.startsWith("CAMPAIGN") ? historyCampaign : lead,
                    ownerId: historyAdvisor.userId,
                    ...extra
                });

            await publish("hist_1", "LEAD_CREATED", { occurredAt: "2026-02-01T00:00:00.000Z" });
            await publish("hist_2", "LEAD_CREATED", { occurredAt: "2026-02-10T00:00:00.000Z" });
            await publish("hist_3", "LEAD_STATUS_CHANGED", { occurredAt: "2026-02-20T00:00:00.000Z" });
            await publish("hist_4", "CAMPAIGN_ACTIVATED", { occurredAt: "2026-03-01T00:00:00.000Z" });

            historyAdvisor.lead = lead;
            historyAdvisor.campaignId = historyCampaign;
        });

        const history = (query) =>
            server.request("GET", `/automations/events${query}`, { token: historyAdvisor.token });

        test("filters by event type, entity, campaign, status and source", async () => {
            assert.deepEqual(
                (await history("?eventType=LEAD_CREATED")).body.data.map((e) => e.eventId).sort(),
                ["hist_1", "hist_2"]
            );
            assert.equal((await history("?entityType=CAMPAIGN")).body.data.length, 1);
            assert.equal((await history(`?entityId=${historyAdvisor.lead}`)).body.data.length, 3);
            assert.equal((await history(`?campaignId=${historyAdvisor.campaignId}`)).body.data.length, 1);
            assert.equal((await history("?processingStatus=PROCESSED")).body.data.length, 4);
            assert.equal((await history("?processingStatus=FAILED")).body.data.length, 0);
            assert.equal((await history("?source=SIMULATION")).body.data.length, 0);
            assert.equal((await history("?source=INTERNAL")).body.data.length, 4);
        });

        test("filters by date range", async () => {
            const feb = await history("?from=2026-02-05T00:00:00.000Z&to=2026-02-25T00:00:00.000Z");

            assert.deepEqual(feb.body.data.map((e) => e.eventId).sort(), ["hist_2", "hist_3"]);
        });

        test("sorting is stable (newest first) and pagination is database-backed", async () => {
            const all = await history("?limit=100");

            assert.deepEqual(all.body.data.map((e) => e.eventId), ["hist_4", "hist_3", "hist_2", "hist_1"]);

            const first = await history("?limit=3&page=1");
            const second = await history("?limit=3&page=2");

            assert.deepEqual(first.body.data.map((e) => e.eventId), ["hist_4", "hist_3", "hist_2"]);
            assert.deepEqual(second.body.data.map((e) => e.eventId), ["hist_1"]);
            assert.deepEqual(second.body.pagination, { page: 2, limit: 3, total: 4, totalPages: 2 });
            assert.equal(first.body.count, 3);
        });

        test("invalid queries return structured errors", async () => {
            for (const query of [
                "?eventType=NOPE",
                "?from=yesterday",
                "?from=2026-03-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z",
                "?processingStatus=DONE",
                "?entityId=bad",
                "?page=-1",
                "?bogus=1"
            ]) {
                const response = await history(query);

                assert.equal(response.status, 400, query);
                assert.equal(response.body.success, false);
                assert.ok(response.body.error.message);
            }
        });

        test("processing outcomes are preserved in the history", async () => {
            const response = await history("?limit=100");

            assert.ok(response.body.data.every((event) => event.processedAt && event.processingStatus === "PROCESSED"));
        });
    });
});
