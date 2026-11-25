import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
    connectTestDatabase,
    disconnectTestDatabase,
    restartDatabaseConnection,
    createTestContext,
    startServer,
    createAdvisor,
    ruleBody,
    AutomationRule,
    ActivityEvent,
    AutomationExecution
} from "./helpers/automationTestKit.js";

// Guide section 8.1: database persistence.

describe("Automation persistence (MongoDB)", () => {
    let server;
    let advisor;

    before(async () => {
        await connectTestDatabase("persistence");
        server = await startServer(createTestContext().app);
        advisor = await createAdvisor();
    });

    after(async () => {
        await server.close();
        await disconnectTestDatabase();
    });

    test("creating a rule stores a document in MongoDB", async () => {
        const response = await server.request("POST", "/automations", {
            token: advisor.token,
            body: ruleBody({ name: "Stored rule", description: "  trimmed  " })
        });

        assert.equal(response.status, 201);
        assert.equal(response.body.success, true);

        const stored = await AutomationRule.findById(response.body.data._id).lean();

        assert.ok(stored, "the rule must exist in the automationRules collection");
        assert.equal(String(stored.ownerId), advisor.userId);
        assert.equal(stored.name, "Stored rule");
        assert.equal(stored.description, "trimmed");
        assert.equal(stored.enabled, false, "rules are disabled by default");
        assert.equal(stored.delayMinutes, 0);
        assert.equal(stored.campaignId, null);
        assert.equal(stored.lastExecutedAt, null);
        assert.ok(stored.createdAt && stored.updatedAt, "timestamps are managed");
    });

    test("a rule can be retrieved after it was created", async () => {
        const created = await server.request("POST", "/automations", {
            token: advisor.token,
            body: ruleBody({ name: "Retrievable rule" })
        });

        const byId = await server.request("GET", `/automations/${created.body.data._id}`, {
            token: advisor.token
        });
        const list = await server.request("GET", "/automations?trigger=LEAD_CREATED", {
            token: advisor.token
        });

        assert.equal(byId.status, 200);
        assert.equal(byId.body.data.name, "Retrievable rule");
        assert.ok(list.body.data.some((rule) => rule._id === created.body.data._id));
    });

    test("rule updates persist", async () => {
        const created = await server.request("POST", "/automations", {
            token: advisor.token,
            body: ruleBody({ name: "Before update" })
        });
        const id = created.body.data._id;

        const updated = await server.request("PATCH", `/automations/${id}`, {
            token: advisor.token,
            body: { name: "After update", enabled: true, delayMinutes: 90 }
        });

        assert.equal(updated.status, 200);

        const stored = await AutomationRule.findById(id).lean();

        assert.equal(stored.name, "After update");
        assert.equal(stored.enabled, true);
        assert.equal(stored.delayMinutes, 90);
        assert.ok(stored.updatedAt > stored.createdAt);
    });

    test("a simulated event stores an ActivityEvent and its executions", async () => {
        await server.request("POST", "/automations", {
            token: advisor.token,
            body: ruleBody({ name: "Matches simulation", enabled: true })
        });

        const response = await server.request("POST", "/automations/simulate-event", {
            token: advisor.token,
            body: { eventId: "evt_persist_001", eventType: "LEAD_CREATED" }
        });

        assert.equal(response.status, 201);

        const stored = await ActivityEvent.findOne({ eventId: "evt_persist_001" }).lean();

        assert.ok(stored, "the event must exist in the activityEvents collection");
        assert.equal(String(stored.ownerId), advisor.userId);
        assert.equal(stored.entityType, "LEAD");
        assert.equal(stored.source, "SIMULATION");
        assert.equal(stored.processingStatus, "PROCESSED");
        assert.ok(stored.matchedRuleCount >= 1);
        assert.notEqual(String(stored._id), stored.eventId, "eventId is not the document _id");

        const executions = await AutomationExecution.find({ eventId: "evt_persist_001" }).lean();

        assert.ok(executions.length >= 1);
        assert.ok(executions.every((execution) => execution.simulated === true));
    });

    test("events can be retrieved after they were created", async () => {
        const response = await server.request("GET", "/automations/events?eventType=LEAD_CREATED", {
            token: advisor.token
        });

        assert.equal(response.status, 200);
        assert.ok(response.body.data.some((event) => event.eventId === "evt_persist_001"));
    });

    test("records remain available after a backend restart", async () => {
        const created = await server.request("POST", "/automations", {
            token: advisor.token,
            body: ruleBody({ name: "Survives restart" })
        });

        await server.close();
        // Nothing in memory survives: new connection, new app, new services.
        await restartDatabaseConnection();
        server = await startServer(createTestContext().app);

        const rule = await server.request("GET", `/automations/${created.body.data._id}`, {
            token: advisor.token
        });
        const events = await server.request("GET", "/automations/events", {
            token: advisor.token
        });

        assert.equal(rule.status, 200);
        assert.equal(rule.body.data.name, "Survives restart");
        assert.ok(events.body.data.some((event) => event.eventId === "evt_persist_001"));
    });

    test("invalid documents are rejected by the schemas", async () => {
        await assert.rejects(() => AutomationRule.create({}), { name: "ValidationError" });

        await assert.rejects(
            () => AutomationRule.create({
                ownerId: advisor.userId,
                name: "Bad enum",
                trigger: "NOT_A_TRIGGER",
                action: "SEND_EMAIL"
            }),
            { name: "ValidationError" }
        );

        await assert.rejects(
            () => AutomationRule.create({
                ownerId: advisor.userId,
                name: "Bad delay",
                trigger: "LEAD_CREATED",
                action: "CREATE_NOTIFICATION",
                delayMinutes: 1.5
            }),
            { name: "ValidationError" }
        );

        await assert.rejects(
            () => ActivityEvent.create({
                eventId: "evt_bad",
                eventType: "NOT_AN_EVENT",
                entityId: advisor.userId,
                entityType: "LEAD",
                ownerId: advisor.userId
            }),
            { name: "ValidationError" }
        );

        await assert.rejects(
            () => AutomationExecution.create({ eventId: "evt_bad" }),
            { name: "ValidationError" }
        );
    });

    test("required indexes exist, including the unique ones", async () => {
        const indexOf = async (model, keys) => {
            const indexes = await model.collection.indexes();

            return indexes.find(
                (index) => JSON.stringify(index.key) === JSON.stringify(keys)
            );
        };

        const eventIdIndex = await indexOf(ActivityEvent, { eventId: 1 });
        const executionIndex = await indexOf(AutomationExecution, { eventId: 1, automationRuleId: 1 });
        const dueIndex = await indexOf(AutomationExecution, { status: 1, scheduledFor: 1 });
        const ownerRulesIndex = await indexOf(AutomationRule, { ownerId: 1, enabled: 1 });

        assert.ok(eventIdIndex?.unique, "ActivityEvent.eventId must be unique");
        assert.ok(executionIndex?.unique, "(eventId, automationRuleId) must be unique");
        assert.ok(dueIndex, "executions need an index for due-work queries");
        assert.ok(ownerRulesIndex, "rules need an owner index");
    });
});
