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
    createAdmin,
    createAssignment,
    createCampaign,
    createLead,
    createDeliveryJob,
    ruleBody
} from "./helpers/automationTestKit.js";

// Guide section 8.7: analytics computed with MongoDB aggregation, scoped to
// the caller, correct on empty and populated data.

describe("Automation analytics", () => {
    let context;
    let server;
    let delivery;
    let advisor;
    let rival;
    let empty;
    let specialist;
    let admin;
    let activeCampaign;
    let completedCampaign;

    const summary = async (who) => {
        const response = await server.request("GET", "/analytics/summary", { token: who.token });

        assert.equal(response.status, 200, JSON.stringify(response.body));

        return response.body.data;
    };

    before(async () => {
        await connectTestDatabase("analytics");

        delivery = createMockDelivery();
        context = createTestContext({ delivery });
        server = await startServer(context.app);

        [advisor, rival, empty, specialist, admin] = await Promise.all([
            createAdvisor("Main"),
            createAdvisor("Rival"),
            createAdvisor("Empty"),
            createSpecialist("Analyst"),
            createAdmin()
        ]);

        activeCampaign = await createCampaign({
            advisorId: advisor.advisorId,
            assignedSpecialistIds: [specialist.userId]
        });
        completedCampaign = await createCampaign({ advisorId: advisor.advisorId, status: "COMPLETED" });
        const rivalCampaign = await createCampaign({ advisorId: rival.advisorId });

        await createAssignment({ advisorId: advisor.advisorId, specialistUserId: specialist.userId });

        // Business data: 3 leads (1 converted), 3 deliveries.
        await createLead({ advisorId: advisor.advisorId, status: "NEW" });
        await createLead({ advisorId: advisor.advisorId, status: "NEW" });
        await createLead({ advisorId: advisor.advisorId, status: "CONVERTED" });
        await createLead({ advisorId: rival.advisorId, status: "CONVERTED" });

        await createDeliveryJob({ advisorId: advisor.advisorId, campaignId: activeCampaign, deliveryStatus: "SENT" });
        await createDeliveryJob({ advisorId: advisor.advisorId, campaignId: activeCampaign, deliveryStatus: "SENT" });
        await createDeliveryJob({ advisorId: advisor.advisorId, campaignId: completedCampaign, deliveryStatus: "FAILED" });
        await createDeliveryJob({ advisorId: rival.advisorId, campaignId: rivalCampaign, deliveryStatus: "SENT" });

        // Automation data for the main advisor.
        const make = async (body, who = advisor) => {
            const response = await server.request("POST", "/automations", { token: who.token, body });

            assert.equal(response.status, 201, JSON.stringify(response.body));

            return response.body.data;
        };

        await make(ruleBody({ name: "Notify on lead", trigger: "LEAD_CREATED", action: "CREATE_NOTIFICATION", enabled: true }));
        await make(ruleBody({
            name: "Email on lead",
            trigger: "LEAD_CREATED",
            action: "SEND_EMAIL",
            campaignId: activeCampaign,
            enabled: true
        }));
        await make(ruleBody({
            name: "Follow up",
            trigger: "CONSULTATION_REQUESTED",
            action: "SCHEDULE_FOLLOW_UP",
            campaignId: activeCampaign,
            delayMinutes: 500,
            enabled: false
        }));
        await make(
            ruleBody({ name: "Rival rule", trigger: "LEAD_CREATED", action: "CREATE_NOTIFICATION", enabled: true }),
            rival
        );

        // Two simulations (notification matches; with campaign metadata also the email rule).
        await server.request("POST", "/automations/simulate-event", {
            token: advisor.token,
            body: { eventId: "an_sim_1", eventType: "LEAD_CREATED" }
        });
        await server.request("POST", "/automations/simulate-event", {
            token: advisor.token,
            body: { eventId: "an_sim_2", eventType: "LEAD_STATUS_CHANGED" }
        });

        // One real execution (email through the mock delivery adapter) and one with no match.
        await context.service.publishEvent({
            eventId: "an_real_1",
            eventType: "LEAD_CREATED",
            entityId: await createLead({ advisorId: advisor.advisorId, status: "NEW" }),
            ownerId: advisor.userId,
            metadata: { campaignId: activeCampaign }
        });
    });

    after(async () => {
        await server.close();
        await disconnectTestDatabase();
    });

    test("requires authentication", async () => {
        assert.equal((await server.request("GET", "/analytics/summary")).status, 401);
    });

    test("an advisor with no data gets zeros, not errors", async () => {
        const data = await summary(empty);

        assert.deepEqual(data.rules, { total: 0, enabled: 0, disabled: 0, byTrigger: {}, byAction: {} });
        assert.equal(data.events.total, 0);
        assert.deepEqual(data.events.byType, {});
        assert.equal(data.simulatedActions.total, 0);
        assert.equal(data.executedActions.total, 0);
        assert.equal(data.business.leads.total, 0);
        assert.equal(data.business.leads.conversionRate, 0, "no division by zero");
        assert.equal(data.business.campaigns.total, 0);
        assert.equal(data.business.deliveries.total, 0);
        assert.ok(!Number.isNaN(Date.parse(data.generatedAt)));
    });

    test("rule counts and groupings", async () => {
        const { rules } = await summary(advisor);

        assert.equal(rules.total, 3);
        assert.equal(rules.enabled, 2);
        assert.equal(rules.disabled, 1);
        assert.deepEqual(rules.byTrigger, { LEAD_CREATED: 2, CONSULTATION_REQUESTED: 1 });
        assert.deepEqual(rules.byAction, { CREATE_NOTIFICATION: 1, SEND_EMAIL: 1, SCHEDULE_FOLLOW_UP: 1 });
    });

    test("event counts, groupings and matched-rule counts", async () => {
        const { events } = await summary(advisor);

        // 3 submitted events + 2 audit events written by the real execution.
        assert.equal(events.total, 5);
        assert.equal(events.withMatchingRules, 2, "LEAD_STATUS_CHANGED and the audit events matched nothing");
        assert.equal(events.byType.LEAD_CREATED, 2);
        assert.equal(events.byType.LEAD_STATUS_CHANGED, 1);
        assert.equal(events.byType.AUTOMATION_EXECUTED, 2);
        assert.equal(events.byProcessingStatus.PROCESSED, events.total - (events.byProcessingStatus.FAILED ?? 0));
    });

    test("simulated and executed actions are counted separately", async () => {
        const data = await summary(advisor);

        assert.equal(data.simulatedActions.total, 1, "only the notification rule matched the simulation");
        assert.deepEqual(data.simulatedActions.byAction, { CREATE_NOTIFICATION: 1 });

        assert.equal(data.executedActions.byStatus.COMPLETED, 2);
        assert.equal(data.executedActions.total, 2);
        assert.deepEqual(data.executedActions.byAction, { CREATE_NOTIFICATION: 1, SEND_EMAIL: 1 });
    });

    test("business metrics: leads, conversion rate, campaigns, deliveries", async () => {
        const { business } = await summary(advisor);

        assert.equal(business.leads.total, 4);
        assert.equal(business.leads.converted, 1);
        assert.equal(business.leads.conversionRate, 25);
        assert.deepEqual(business.leads.byStatus, { NEW: 3, CONVERTED: 1 });

        assert.equal(business.campaigns.total, 2);
        assert.equal(business.campaigns.active, 1);
        assert.equal(business.campaigns.completed, 1);

        assert.equal(business.deliveries.total, 3);
        assert.equal(business.deliveries.sent, 2);
        assert.equal(business.deliveries.failed, 1);
    });

    test("the conversion rate is rounded to two decimals", async () => {
        const fresh = await createAdvisor("Rounding");

        await createLead({ advisorId: fresh.advisorId, status: "CONVERTED" });
        await createLead({ advisorId: fresh.advisorId, status: "NEW" });
        await createLead({ advisorId: fresh.advisorId, status: "NEW" });

        assert.equal((await summary(fresh)).business.leads.conversionRate, 33.33);
    });

    test("advisors never see each other's numbers", async () => {
        const mine = await summary(advisor);
        const theirs = await summary(rival);

        assert.equal(theirs.rules.total, 1);
        assert.equal(theirs.events.total, 0);
        assert.equal(theirs.business.leads.total, 1);
        assert.equal(theirs.business.deliveries.total, 1);
        assert.equal(mine.business.deliveries.total, 3);
    });

    test("a specialist sees only assigned campaigns and no lead data", async () => {
        const data = await summary(specialist);

        assert.equal(data.scope.level, "ASSIGNED_CAMPAIGNS");
        assert.equal(data.scope.campaignCount, 1);
        assert.equal(data.business.leads, null);
        assert.equal(data.business.campaigns.total, 1);
        assert.equal(data.business.deliveries.total, 2, "only the assigned campaign's deliveries");
        assert.equal(data.business.deliveries.failed, 0);
        assert.equal(data.rules.total, 2, "only rules on the assigned campaign");
    });

    test("an administrator sees the platform totals", async () => {
        const data = await summary(admin);

        assert.equal(data.scope.level, "PLATFORM");
        assert.equal(data.rules.total, 4, "every advisor's rules");
        assert.equal(data.business.leads.total >= 5, true);
        assert.equal(data.business.deliveries.total >= 4, true);
    });

    test("the summary is computed from MongoDB, so new data shows up immediately", async () => {
        const before = (await summary(advisor)).business.leads.total;

        await createLead({ advisorId: advisor.advisorId });

        assert.equal((await summary(advisor)).business.leads.total, before + 1);
    });

    test("query parameters cannot widen the scope", async () => {
        const response = await server.request(
            "GET",
            `/analytics/summary?ownerId=${rival.userId}&advisorId=${rival.advisorId}`,
            { token: advisor.token }
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.data.rules.total, 3, "still the caller's own data");
    });
});
