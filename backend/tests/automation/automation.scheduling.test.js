import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

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
    sleep,
    AutomationExecution,
    AutomationRule,
    Campaign
} from "./helpers/automationTestKit.js";
import createAutomationWorker from "../../src/modules/automation/automationWorker.js";

// Guide section 8.6: scheduled follow-ups. The schedule lives in MongoDB
// (PENDING AutomationExecution documents); nothing depends on timers.

const MINUTE = 60 * 1000;

const makeClock = () => {
    let offset = 0;

    return {
        now: () => new Date(Date.now() + offset),
        advance: (ms) => { offset += ms; }
    };
};

describe("Automation scheduled follow-ups", () => {
    let clock;
    let delivery;
    let context;
    let server;
    let advisor;
    let campaign;
    let lead;
    let counter = 0;

    const createRule = async (overrides = {}) => {
        const response = await server.request("POST", "/automations", {
            token: advisor.token,
            body: ruleBody({
                name: `Follow-up rule ${(counter += 1)}`,
                trigger: "CONSULTATION_REQUESTED",
                action: "SCHEDULE_FOLLOW_UP",
                campaignId: campaign,
                enabled: true,
                ...overrides
            })
        });

        assert.equal(response.status, 201, JSON.stringify(response.body));

        return response.body.data;
    };

    const retire = async (rule) =>
        server.request("PATCH", `/automations/${rule._id}`, { token: advisor.token, body: { enabled: false } });

    const publish = (eventId, extra = {}, service = context.service) =>
        service.publishEvent({
            eventId,
            eventType: "CONSULTATION_REQUESTED",
            entityType: "LEAD",
            entityId: lead,
            ownerId: advisor.userId,
            metadata: { campaignId: campaign },
            ...extra
        });

    const executionFor = (eventId) => AutomationExecution.findOne({ eventId }).lean();

    before(async () => {
        await connectTestDatabase("scheduling");

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

    test("scheduledFor is occurredAt plus delayMinutes, stored in MongoDB", async () => {
        const rule = await createRule({ delayMinutes: 90 });
        const occurredAt = new Date(clock.now().getTime() - 5 * MINUTE);

        await publish("evt_sched_calc", { occurredAt: occurredAt.toISOString() });

        const execution = await executionFor("evt_sched_calc");

        assert.equal(execution.status, "PENDING");
        assert.equal(execution.scheduledFor.getTime(), occurredAt.getTime() + 90 * MINUTE);
        assert.equal(String(execution.automationRuleId), rule._id);
        await retire(rule);
    });

    test("nothing runs early; it runs once when due", async () => {
        const rule = await createRule({ delayMinutes: 60 });

        delivery.calls.length = 0;
        await publish("evt_sched_due");

        await context.service.processDueExecutions();
        assert.equal(delivery.calls.length, 0, "not due yet");

        clock.advance(59 * MINUTE);
        await context.service.processDueExecutions();
        assert.equal(delivery.calls.length, 0, "one minute still to go");

        clock.advance(2 * MINUTE);
        await context.service.processDueExecutions();
        await context.service.processDueExecutions();

        assert.equal(delivery.calls.length, 1, "runs once, not on every pass");

        const execution = await executionFor("evt_sched_due");

        assert.equal(execution.status, "COMPLETED");
        assert.ok(execution.completedAt);
        assert.equal(delivery.calls[0].action, undefined);
        assert.equal(delivery.calls[0].channel, "EMAIL");
        await retire(rule);
    });

    test("a zero delay runs immediately", async () => {
        const rule = await createRule({ delayMinutes: 0 });

        delivery.calls.length = 0;
        await publish("evt_sched_now");

        assert.equal(delivery.calls.length, 1);
        assert.equal((await executionFor("evt_sched_now")).status, "COMPLETED");
        await retire(rule);
    });

    test("an event whose delay has already elapsed runs right away", async () => {
        const rule = await createRule({ delayMinutes: 30 });

        delivery.calls.length = 0;
        await publish("evt_sched_late", {
            occurredAt: new Date(clock.now().getTime() - 3 * 60 * MINUTE).toISOString()
        });

        assert.equal(delivery.calls.length, 1);
        await retire(rule);
    });

    test("scheduled work survives a restart and a fresh worker runs it", async () => {
        const rule = await createRule({ delayMinutes: 120 });

        await publish("evt_sched_restart");
        await restartDatabaseConnection();

        const pending = await executionFor("evt_sched_restart");

        assert.equal(pending.status, "PENDING", "still stored after reconnecting");

        const freshDelivery = createMockDelivery();
        const worker = createWorkerService({ delivery: freshDelivery, clock: clock.now });

        await worker.processDue();
        assert.equal(freshDelivery.calls.length, 0);

        clock.advance(121 * MINUTE);
        await worker.processDue();

        assert.equal(freshDelivery.calls.length, 1);
        assert.equal((await executionFor("evt_sched_restart")).status, "COMPLETED");
        await retire(rule);
    });

    test("several workers share the schedule without running anything twice", async () => {
        const rule = await createRule({ delayMinutes: 10 });
        const sharedDelivery = createMockDelivery();

        for (let i = 0; i < 5; i += 1) await publish(`evt_sched_multi_${i}`);

        clock.advance(11 * MINUTE);

        await Promise.all(
            Array.from({ length: 4 }, (_, i) =>
                createWorkerService({ delivery: sharedDelivery, clock: clock.now, workerId: `w${i}` }).processDue())
        );

        assert.equal(sharedDelivery.calls.length, 5);
        assert.equal(new Set(sharedDelivery.calls.map((call) => call.idempotencyKey)).size, 5);
        await retire(rule);
    });

    test("a rule disabled before the due time is skipped, not executed", async () => {
        const rule = await createRule({ delayMinutes: 45 });

        delivery.calls.length = 0;
        await publish("evt_sched_disabled");
        await retire(rule);

        clock.advance(50 * MINUTE);
        await context.service.processDueExecutions();

        const execution = await executionFor("evt_sched_disabled");

        assert.equal(delivery.calls.length, 0);
        assert.equal(execution.status, "SKIPPED");
        assert.equal(execution.error.code, "RULE_DISABLED");
    });

    test("a rule that was re-enabled before the due time still runs", async () => {
        const rule = await createRule({ delayMinutes: 45 });

        delivery.calls.length = 0;
        await publish("evt_sched_reenabled");
        await retire(rule);
        await server.request("PATCH", `/automations/${rule._id}`, { token: advisor.token, body: { enabled: true } });

        clock.advance(50 * MINUTE);
        await context.service.processDueExecutions();

        assert.equal(delivery.calls.length, 1);
        await retire(rule);
    });

    test("an execution whose campaign no longer belongs to the owner fails safely", async () => {
        const rule = await createRule({ delayMinutes: 5 });

        delivery.calls.length = 0;
        await publish("evt_sched_campaign_gone");

        const other = await createAdvisor("NewOwner");

        await Campaign.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(campaign) },
            { $set: { advisorId: new mongoose.Types.ObjectId(other.advisorId) } }
        );

        clock.advance(10 * MINUTE);
        await context.service.processDueExecutions();

        const execution = await executionFor("evt_sched_campaign_gone");

        assert.equal(delivery.calls.length, 0);
        assert.equal(execution.status, "FAILED");
        assert.equal(execution.error.code, "CAMPAIGN_UNAVAILABLE");

        await Campaign.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(campaign) },
            { $set: { advisorId: new mongoose.Types.ObjectId(advisor.advisorId) } }
        );
        await retire(rule);
    });

    test("Delivery failures are recorded on the execution and in the rule history", async () => {
        const rule = await createRule({ delayMinutes: 5 });
        const refusing = createMockDelivery(() => { throw deliveryError(422, "CAMPAIGN_NOT_ACTIVE"); });
        const ctx = createTestContext({ delivery: refusing, clock: clock.now });

        await publish("evt_sched_failure", {}, ctx.service);
        clock.advance(10 * MINUTE);
        await ctx.service.processDueExecutions();

        const execution = await executionFor("evt_sched_failure");

        assert.equal(execution.status, "FAILED");
        assert.equal(execution.error.code, "CAMPAIGN_NOT_ACTIVE");

        const listed = await server.request("GET", "/automations/executions?limit=100", { token: advisor.token });
        const found = listed.body.data.find((item) => item.eventId === "evt_sched_failure");

        assert.equal(found.status, "FAILED");
        assert.equal((await AutomationRule.findById(rule._id).lean()).executionCount, 0);
        await retire(rule);
    });

    test("executions are visible through the API with their schedule", async () => {
        const rule = await createRule({ delayMinutes: 1000 });

        await publish("evt_sched_visible");

        const response = await server.request("GET", "/automations/executions?limit=100", { token: advisor.token });
        const item = response.body.data.find((entry) => entry.eventId === "evt_sched_visible");

        assert.equal(item.status, "PENDING");
        assert.ok(item.scheduledFor);
        assert.equal(item.automationRuleId, rule._id);
        await retire(rule);
    });

    describe("worker", () => {
        test("a tick processes due work and never throws", async () => {
            const rule = await createRule({ delayMinutes: 5 });
            const workerDelivery = createMockDelivery();
            const worker = createAutomationWorker({
                executionService: createWorkerService({ delivery: workerDelivery, clock: clock.now }),
                logger: { error() {} }
            });

            await publish("evt_worker_tick");
            clock.advance(6 * MINUTE);

            const summary = await worker.tick();

            assert.ok(summary.claimed >= 1);
            assert.ok(workerDelivery.calls.length >= 1);
            await retire(rule);
        });

        test("passes never overlap", async () => {
            let release;
            const gate = new Promise((resolve) => { release = resolve; });
            const worker = createAutomationWorker({
                executionService: { processDue: async () => { await gate; return { claimed: 0 }; } },
                logger: { error() {} }
            });

            const first = worker.tick();
            const second = await worker.tick();

            assert.equal(second, null, "a pass already in progress is not doubled");
            release();
            assert.deepEqual(await first, { claimed: 0 });
        });

        test("a failing pass is logged and the next pass still works", async () => {
            const errors = [];
            let calls = 0;
            const worker = createAutomationWorker({
                executionService: {
                    processDue: async () => {
                        calls += 1;
                        if (calls === 1) throw new Error("database blip");

                        return { claimed: 3 };
                    }
                },
                logger: { error: (...args) => errors.push(args.join(" ")) }
            });

            assert.equal(await worker.tick(), null);
            assert.deepEqual(await worker.tick(), { claimed: 3 });
            assert.equal(errors.length, 1);
        });

        test("start and stop control the polling loop", async () => {
            let passes = 0;
            const worker = createAutomationWorker({
                executionService: { processDue: async () => { passes += 1; return {}; } },
                intervalMs: 20,
                logger: { error() {} }
            });

            worker.start();
            worker.start();
            assert.equal(worker.isRunning, true);

            await sleep(120);
            worker.stop();

            const seen = passes;

            assert.ok(seen >= 2, `polled repeatedly (${seen})`);
            assert.equal(worker.isRunning, false);

            await sleep(80);
            assert.equal(passes, seen, "no passes after stop");
        });
    });
});
