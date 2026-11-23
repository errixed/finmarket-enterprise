import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
    connectTestDatabase,
    disconnectTestDatabase,
    restartDatabaseConnection,
    createTestContext,
    createWorkerService,
    createMockDelivery,
    deliveryError,
    startServer,
    createAdvisor,
    createCampaign,
    createLead,
    ruleBody,
    ActivityEvent,
    AutomationExecution
} from "./helpers/automationTestKit.js";

// Guide section 8.5: duplicate events and duplicate executions, including
// concurrency, restart, and the retry / uncertain-outcome policy.

const makeClock = () => {
    let offset = 0;

    return {
        now: () => new Date(Date.now() + offset),
        advance: (ms) => { offset += ms; }
    };
};

describe("Automation duplicate prevention", () => {
    let clock;
    let delivery;
    let context;
    let server;
    let advisor;
    let campaign;
    let lead;
    let counter = 0;

    const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(counter += 1)}`;

    const createRule = async (overrides = {}) => {
        const response = await server.request("POST", "/automations", {
            token: advisor.token,
            body: ruleBody({
                name: nextId("rule"),
                trigger: "LEAD_CREATED",
                action: "SEND_EMAIL",
                campaignId: campaign,
                enabled: true,
                ...overrides
            })
        });

        assert.equal(response.status, 201, JSON.stringify(response.body));

        return response.body.data;
    };

    const disableAllRules = () =>
        server.request("GET", "/automations?limit=100", { token: advisor.token }).then(async (res) => {
            for (const rule of res.body.data.filter((item) => item.enabled)) {
                await server.request("PATCH", `/automations/${rule._id}`, {
                    token: advisor.token,
                    body: { enabled: false }
                });
            }
        });

    const publish = (eventId, extra = {}, service = context.service) =>
        service.publishEvent({
            eventId,
            eventType: "LEAD_CREATED",
            entityType: "LEAD",
            entityId: lead,
            ownerId: advisor.userId,
            metadata: { campaignId: campaign },
            ...extra
        });

    const executionsFor = (eventId) => AutomationExecution.find({ eventId }).lean();

    before(async () => {
        await connectTestDatabase("duplicates");

        clock = makeClock();
        delivery = createMockDelivery();
        context = createTestContext({ delivery, clock: clock.now });
        server = await startServer(context.app);

        advisor = await createAdvisor("Owner");
        campaign = await createCampaign({ advisorId: advisor.advisorId });
        lead = await createLead({ advisorId: advisor.advisorId });
    });

    after(async () => {
        await server.close();
        await disconnectTestDatabase();
    });

    describe("duplicate events", () => {
        test("the same eventId is stored once and the second submission is a conflict", async () => {
            await createRule({ action: "CREATE_NOTIFICATION", campaignId: null });

            const body = { eventId: "evt_dup_http_001", eventType: "LEAD_CREATED" };
            const first = await server.request("POST", "/automations/simulate-event", { token: advisor.token, body });
            const second = await server.request("POST", "/automations/simulate-event", { token: advisor.token, body });

            assert.equal(first.status, 201);
            assert.equal(second.status, 409);
            assert.equal(second.body.error.code, "EVENT_ALREADY_PROCESSED");
            assert.equal(await ActivityEvent.countDocuments({ eventId: "evt_dup_http_001" }), 1);
        });

        test("an eventId already used by another advisor is also rejected, without leaking it", async () => {
            const stranger = await createAdvisor("Stranger");
            const response = await server.request("POST", "/automations/simulate-event", {
                token: stranger.token,
                body: { eventId: "evt_dup_http_001", eventType: "LEAD_CREATED" }
            });

            assert.equal(response.status, 409);
            assert.equal(await ActivityEvent.countDocuments({ eventId: "evt_dup_http_001" }), 1);
            assert.equal(
                (await server.request("GET", "/automations/events?limit=100", { token: stranger.token }))
                    .body.data.length,
                0
            );
        });

        test("ten concurrent submissions of one eventId create one event and one execution", async () => {
            await disableAllRules();
            const rule = await createRule({ action: "CREATE_NOTIFICATION", campaignId: null });
            const body = { eventId: "evt_concurrent_http", eventType: "LEAD_CREATED" };

            const results = await Promise.all(
                Array.from({ length: 10 }, () =>
                    server.request("POST", "/automations/simulate-event", { token: advisor.token, body }))
            );
            const statuses = results.map((result) => result.status).sort();

            assert.equal(statuses.filter((status) => status === 201).length, 1);
            assert.equal(statuses.filter((status) => status === 409).length, 9);
            assert.equal(await ActivityEvent.countDocuments({ eventId: "evt_concurrent_http" }), 1);

            const executions = await executionsFor("evt_concurrent_http");

            assert.equal(executions.length, 1);
            assert.equal(String(executions[0].automationRuleId), rule._id);
        });

        test("a duplicate trusted event is reported as a duplicate and does nothing again", async () => {
            await disableAllRules();
            await createRule();
            delivery.calls.length = 0;

            const first = await publish("evt_dup_internal");
            const second = await publish("evt_dup_internal");

            assert.equal(first.duplicate, false);
            assert.equal(second.duplicate, true);
            assert.equal(delivery.calls.length, 1, "delivery requested exactly once");
            assert.equal(await ActivityEvent.countDocuments({ eventId: "evt_dup_internal" }), 1);
        });

        test("concurrent trusted publications of one event reach Delivery once", async () => {
            await disableAllRules();
            await createRule();
            delivery.calls.length = 0;

            const results = await Promise.all(
                Array.from({ length: 12 }, () => publish("evt_dup_concurrent_internal"))
            );

            assert.equal(results.filter((result) => !result.duplicate).length, 1);
            assert.equal(delivery.calls.length, 1);
            assert.equal((await executionsFor("evt_dup_concurrent_internal")).length, 1);
        });

        test("eventId is the dedup key and differs from the ActivityEvent _id", async () => {
            const stored = await ActivityEvent.findOne({ eventId: "evt_dup_internal" }).lean();

            assert.notEqual(String(stored._id), stored.eventId);
        });
    });

    describe("duplicate executions", () => {
        test("one execution per event and rule; separate rules each run once", async () => {
            await disableAllRules();
            const first = await createRule();
            const second = await createRule();
            delivery.calls.length = 0;

            await publish("evt_two_rules");
            await publish("evt_two_rules");

            const executions = await executionsFor("evt_two_rules");

            assert.equal(executions.length, 2);
            assert.deepEqual(
                executions.map((item) => String(item.automationRuleId)).sort(),
                [first._id, second._id].sort()
            );
            assert.equal(delivery.calls.length, 2);
            assert.deepEqual(
                delivery.calls.map((call) => call.idempotencyKey).sort(),
                [`evt_two_rules:${first._id}`, `evt_two_rules:${second._id}`].sort()
            );
        });

        test("the database refuses a second execution for the same event and rule", async () => {
            const [existing] = await executionsFor("evt_two_rules");
            const { _id, ...copy } = existing;

            await assert.rejects(
                () => AutomationExecution.collection.insertOne({ ...copy, createdAt: new Date() }),
                { code: 11000 }
            );
            assert.equal((await executionsFor("evt_two_rules")).length, 2);
        });

        test("the same rule runs again for a different event", async () => {
            await disableAllRules();
            await createRule();
            delivery.calls.length = 0;

            await publish("evt_again_1");
            await publish("evt_again_2");

            assert.equal(delivery.calls.length, 2);
        });

        test("two workers racing for the same due execution run it once", async () => {
            await disableAllRules();
            await createRule({ delayMinutes: 30 });
            delivery.calls.length = 0;

            await publish("evt_race");
            assert.equal(delivery.calls.length, 0, "not due yet");

            clock.advance(31 * 60 * 1000);

            const sharedDelivery = createMockDelivery();
            const workers = Array.from({ length: 6 }, (_, i) =>
                createWorkerService({ delivery: sharedDelivery, clock: clock.now, workerId: `worker-${i}` }));

            await Promise.all(workers.map((worker) => worker.processDue()));

            assert.equal(sharedDelivery.calls.length, 1);

            const [execution] = await executionsFor("evt_race");

            assert.equal(execution.status, "COMPLETED");
            assert.equal(execution.attemptCount, 1);
        });

        test("completed work is not repeated after a restart", async () => {
            await disableAllRules();
            await createRule();
            delivery.calls.length = 0;

            await publish("evt_restart");
            assert.equal(delivery.calls.length, 1);

            await restartDatabaseConnection();

            const freshDelivery = createMockDelivery();
            const fresh = createTestContext({ delivery: freshDelivery, clock: clock.now });
            const again = await publish("evt_restart", {}, fresh.service);

            assert.equal(again.duplicate, true);
            assert.equal(freshDelivery.calls.length, 0);

            clock.advance(60 * 60 * 1000);
            await createWorkerService({ delivery: freshDelivery, clock: clock.now }).processDue();

            assert.equal(freshDelivery.calls.length, 0, "a restarted worker finds nothing to redo");
            assert.equal((await executionsFor("evt_restart")).length, 1);
        });

        test("an unfinished trusted event is resumed on redelivery without duplicating work", async () => {
            await disableAllRules();
            await createRule();
            await createRule();

            // Simulate a crash after the event and one execution were stored.
            const stored = await publish("evt_resume");
            const [one] = await executionsFor("evt_resume");

            await AutomationExecution.deleteOne({ _id: one._id });
            await ActivityEvent.updateOne(
                { eventId: "evt_resume" },
                { $set: { processingStatus: "RECEIVED", processedAt: null } }
            );
            assert.equal(stored.duplicate, false);

            const resumeDelivery = createMockDelivery();
            const resumed = await publish("evt_resume", {}, createTestContext({
                delivery: resumeDelivery, clock: clock.now
            }).service);

            assert.equal(resumed.duplicate, true);

            const executions = await executionsFor("evt_resume");

            assert.equal(executions.length, 2, "the missing execution is recreated, none doubled");
            assert.equal(
                (await ActivityEvent.findOne({ eventId: "evt_resume" }).lean()).processingStatus,
                "PROCESSED"
            );
        });
    });

    describe("retry and uncertain-outcome policy", () => {
        test("a temporary Delivery outage is retried with the same idempotency key", async () => {
            await disableAllRules();
            const rule = await createRule();
            const flaky = createMockDelivery((request, call) => {
                if (call === 1) throw deliveryError(503, "DELIVERY_UNAVAILABLE");

                return { deliveryJobId: "507f1f77bcf86cd799439011", status: "PENDING" };
            });
            const ctx = createTestContext({ delivery: flaky, clock: clock.now });

            await publish("evt_retry", {}, ctx.service);

            let [execution] = await executionsFor("evt_retry");

            assert.equal(execution.status, "PENDING");
            assert.equal(execution.attemptCount, 1);
            assert.equal(execution.error.code, "DELIVERY_UNAVAILABLE");
            assert.ok(new Date(execution.scheduledFor) > clock.now(), "retry is delayed");

            await ctx.service.processDueExecutions();
            assert.equal(flaky.calls.length, 1, "not retried before its backoff has passed");

            clock.advance(6 * 60 * 1000);
            await ctx.service.processDueExecutions();

            [execution] = await executionsFor("evt_retry");

            assert.equal(execution.status, "COMPLETED");
            assert.equal(execution.attemptCount, 2);
            assert.equal(flaky.calls.length, 2);
            assert.equal(flaky.calls[0].idempotencyKey, flaky.calls[1].idempotencyKey);
            assert.equal(flaky.calls[1].idempotencyKey, `evt_retry:${rule._id}`);
        });

        test("retries stop after the maximum number of attempts", async () => {
            await disableAllRules();
            await createRule();
            const down = createMockDelivery(() => { throw deliveryError(503, "DELIVERY_UNAVAILABLE"); });
            const ctx = createTestContext({ delivery: down, clock: clock.now });

            await publish("evt_exhausted", {}, ctx.service);

            for (let i = 0; i < 6; i += 1) {
                clock.advance(60 * 60 * 1000);
                await ctx.service.processDueExecutions();
            }

            const [execution] = await executionsFor("evt_exhausted");

            assert.equal(execution.status, "FAILED");
            assert.equal(execution.error.code, "RETRIES_EXHAUSTED");
            assert.equal(down.calls.length, 3);
        });

        test("a definite rejection from Delivery fails once and is not retried", async () => {
            await disableAllRules();
            await createRule();
            const rejecting = createMockDelivery(() => { throw deliveryError(409, "CONSENT_REQUIRED"); });
            const ctx = createTestContext({ delivery: rejecting, clock: clock.now });

            await publish("evt_rejected", {}, ctx.service);
            clock.advance(24 * 60 * 60 * 1000);
            await ctx.service.processDueExecutions();

            const [execution] = await executionsFor("evt_rejected");

            assert.equal(execution.status, "FAILED");
            assert.equal(execution.error.code, "CONSENT_REQUIRED");
            assert.equal(rejecting.calls.length, 1);

            const audit = await ActivityEvent.findOne({
                eventType: "AUTOMATION_FAILED",
                "metadata.sourceEventId": "evt_rejected"
            }).lean();

            assert.ok(audit, "failure is recorded in the activity history");
        });

        test("an unknown outcome is marked UNCERTAIN and never retried automatically", async () => {
            await disableAllRules();
            await createRule();
            const broken = createMockDelivery(() => { throw new Error("socket hang up"); });
            const ctx = createTestContext({ delivery: broken, clock: clock.now });

            await publish("evt_uncertain", {}, ctx.service);
            clock.advance(24 * 60 * 60 * 1000);
            await ctx.service.processDueExecutions();

            const [execution] = await executionsFor("evt_uncertain");

            assert.equal(execution.status, "UNCERTAIN");
            assert.equal(execution.error.code, "OUTCOME_UNKNOWN");
            assert.equal(broken.calls.length, 1);
        });

        test("work abandoned mid-run by a crashed worker becomes UNCERTAIN, not a repeat", async () => {
            await disableAllRules();
            await createRule({ delayMinutes: 10 });
            await publish("evt_abandoned");

            const [execution] = await executionsFor("evt_abandoned");

            await AutomationExecution.updateOne(
                { _id: execution._id },
                { $set: { status: "PROCESSING", lockedBy: "crashed-worker", lockedAt: clock.now(), attemptCount: 1 } }
            );

            clock.advance(20 * 60 * 1000);

            const rescue = createMockDelivery();
            const summary = await createWorkerService({ delivery: rescue, clock: clock.now }).processDue();
            const after = await AutomationExecution.findById(execution._id).lean();

            assert.equal(summary.uncertain, 1);
            assert.equal(after.status, "UNCERTAIN");
            assert.equal(rescue.calls.length, 0);
        });
    });
});
