import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    connectTestDatabase,
    disconnectTestDatabase,
    createTestContext,
    createMockDelivery,
    startServer,
    createAdvisor,
    createCampaign,
    ruleBody,
    randomObjectId
} from "./helpers/automationTestKit.js";
import {
    ruleMatchesEvent,
    selectMatchingRules,
    calculateScheduledFor,
    planExecution,
    isActionAllowedForTrigger
} from "../../src/modules/automation/eventProcessor.js";
import {
    parseRuleCreate,
    parseEvent,
    sanitizeMetadata
} from "../../src/modules/automation/automationValidation.js";
import {
    TRIGGERS,
    ACTIONS,
    EVENT_TYPES,
    TRIGGER_ACTION_COMPATIBILITY
} from "../../src/modules/automation/automationConstants.js";

// Guide section 8.8: contracts with the other modules and the shared
// conventions. The pure functions need no database; the last block runs the
// whole module against mocked neighbours.

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleDir = path.resolve(here, "../../src/modules/automation");

const listFiles = (dir) =>
    readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);

        return statSync(full).isDirectory() ? listFiles(full) : [full];
    });

describe("Automation contracts", () => {
    describe("event matching (pure)", () => {
        const owner = randomObjectId();
        const campaign = randomObjectId();
        const rule = (overrides = {}) => ({
            _id: randomObjectId(),
            ownerId: owner,
            trigger: "LEAD_CREATED",
            action: "CREATE_NOTIFICATION",
            campaignId: null,
            delayMinutes: 0,
            enabled: true,
            ...overrides
        });
        const event = (overrides = {}) => ({
            eventId: "evt_pure_1",
            eventType: "LEAD_CREATED",
            entityType: "LEAD",
            entityId: randomObjectId(),
            ownerId: owner,
            campaignId: null,
            occurredAt: new Date("2026-03-01T10:00:00.000Z"),
            ...overrides
        });

        test("a rule matches on enabled, trigger and owner", () => {
            assert.equal(ruleMatchesEvent(rule(), event()), true);
            assert.equal(ruleMatchesEvent(rule({ enabled: false }), event()), false);
            assert.equal(ruleMatchesEvent(rule({ trigger: "CAMPAIGN_CREATED" }), event()), false);
            assert.equal(ruleMatchesEvent(rule({ ownerId: randomObjectId() }), event()), false);
        });

        test("ids compare equal whether they are strings or ObjectId-like values", () => {
            const asObject = { toString: () => owner };

            assert.equal(ruleMatchesEvent(rule({ ownerId: asObject }), event()), true);
        });

        test("a campaign-bound rule needs the same campaign on the event", () => {
            const bound = rule({ campaignId: campaign });

            assert.equal(ruleMatchesEvent(bound, event({ campaignId: campaign })), true);
            assert.equal(ruleMatchesEvent(bound, event({ campaignId: randomObjectId() })), false);
            assert.equal(ruleMatchesEvent(bound, event({ campaignId: null })), false);
            assert.equal(ruleMatchesEvent(rule(), event({ campaignId: campaign })), true, "unbound rules match any campaign");
        });

        test("unsafe trigger/action pairs never match", () => {
            const looping = rule({ trigger: "DELIVERY_SENT", action: "SEND_EMAIL" });

            assert.equal(ruleMatchesEvent(looping, event({ eventType: "DELIVERY_SENT" })), false);
            assert.equal(isActionAllowedForTrigger("LEAD_CREATED", "SEND_EMAIL"), true);
            assert.equal(isActionAllowedForTrigger("DELIVERY_QUEUED", "SEND_EMAIL"), false);
        });

        test("selectMatchingRules keeps only the matches, in order", () => {
            const a = rule();
            const b = rule({ enabled: false });
            const c = rule();

            assert.deepEqual(selectMatchingRules([a, b, c], event()), [a, c]);
            assert.deepEqual(selectMatchingRules([], event()), []);
        });

        test("scheduledFor is occurredAt plus the delay, with no drift", () => {
            const at = event({ occurredAt: "2026-03-01T10:00:00.000Z" });

            assert.equal(calculateScheduledFor(at, rule({ delayMinutes: 0 })).toISOString(), "2026-03-01T10:00:00.000Z");
            assert.equal(calculateScheduledFor(at, rule({ delayMinutes: 90 })).toISOString(), "2026-03-01T11:30:00.000Z");
            assert.equal(calculateScheduledFor(at, rule({ delayMinutes: 43200 })).toISOString(), "2026-03-31T10:00:00.000Z");
        });

        test("planExecution builds the idempotency key and keeps simulations apart", () => {
            const r = rule({ delayMinutes: 15 });
            const planned = planExecution(r, event(), { simulated: false });
            const simulated = planExecution(r, event(), { simulated: true });

            assert.equal(planned.idempotencyKey, `evt_pure_1:${r._id}`);
            assert.equal(planned.status, "PENDING");
            assert.equal(simulated.status, "SIMULATED");
            assert.equal(simulated.simulated, true);
            assert.equal(planned.scheduledFor.toISOString(), "2026-03-01T10:15:00.000Z");
        });
    });

    describe("shared vocabulary", () => {
        test("Phase I triggers and actions are all still supported", () => {
            for (const trigger of ["LEAD_CREATED", "LEAD_STATUS_CHANGED", "CONSULTATION_REQUESTED", "CAMPAIGN_ACTIVATED"]) {
                assert.ok(Object.values(TRIGGERS).includes(trigger), trigger);
            }

            for (const action of ["SEND_EMAIL", "SCHEDULE_FOLLOW_UP", "CREATE_NOTIFICATION"]) {
                assert.ok(Object.values(ACTIONS).includes(action), action);
            }
        });

        test("audit events are events but never triggers", () => {
            assert.ok(EVENT_TYPES.includes("AUTOMATION_EXECUTED"));
            assert.ok(EVENT_TYPES.includes("AUTOMATION_FAILED"));
            assert.ok(!Object.values(TRIGGERS).includes("AUTOMATION_EXECUTED"));
            assert.ok(!(("AUTOMATION_EXECUTED") in TRIGGER_ACTION_COMPATIBILITY));
        });

        test("every trigger has at least one permitted action", () => {
            for (const trigger of Object.values(TRIGGERS)) {
                assert.ok(TRIGGER_ACTION_COMPATIBILITY[trigger]?.length > 0, trigger);
            }
        });
    });

    describe("validation helpers (pure)", () => {
        test("parseRuleCreate returns only allowed, normalized fields", () => {
            const parsed = parseRuleCreate({
                name: "  Welcome  ",
                trigger: "LEAD_CREATED",
                action: "CREATE_NOTIFICATION"
            });

            assert.equal(parsed.data.name, "Welcome");
            assert.equal(parsed.data.delayMinutes, 0);
            assert.equal(parsed.data.enabled, false);
            assert.equal("ownerId" in parsed.data, false, "ownership is never taken from the body");
            assert.equal(parsed.claimedOwnerId, undefined);
        });

        test("parseRuleCreate rejects unknown and protected fields", () => {
            assert.throws(
                () => parseRuleCreate({ name: "Valid name", trigger: "LEAD_CREATED", action: "CREATE_NOTIFICATION", role: "ADMIN" }),
                { statusCode: 400 }
            );
        });

        test("parseEvent in simulation mode refuses internal-only fields", () => {
            assert.throws(
                () => parseEvent({ eventType: "LEAD_CREATED", source: "INTERNAL" }, { mode: "simulation" }),
                { statusCode: 400 }
            );
        });

        test("sanitizeMetadata passes safe data through unchanged", () => {
            const input = { previousStatus: "NEW", count: 3, tags: ["a", "b"] };

            assert.deepEqual(sanitizeMetadata(input), input);
            assert.throws(() => sanitizeMetadata({ password: "x" }), { code: "METADATA_NOT_ALLOWED" });
        });
    });

    describe("module boundaries", () => {
        const files = listFiles(moduleDir).filter((file) => file.endsWith(".js"));
        const read = (file) => readFileSync(file, "utf8");

        test("Automation never sends email itself", () => {
            const mailLibraries = /from\s+["'](nodemailer|@sendgrid\/mail|mailgun[^"']*|@aws-sdk\/client-ses|resend|postmark)["']/;

            for (const file of files) {
                assert.doesNotMatch(read(file), mailLibraries, path.relative(moduleDir, file));
            }
        });

        test("only the repository and adapters touch the database", () => {
            const allowed = new Set([
                "automationRepository.js",
                "automationAdapters.js",
                "initializeAutomation.js"
            ]);

            for (const file of files) {
                const relative = path.relative(moduleDir, file);

                if (relative.startsWith("models") || allowed.has(relative)) continue;

                assert.doesNotMatch(
                    read(file),
                    /\.(find|findOne|findById|aggregate|updateOne|updateMany|insertOne|create|countDocuments|deleteOne)\s*\(\s*[{"']?/,
                    `${relative} must go through the repository`
                );
            }
        });

        test("other modules are reached only through adapters", () => {
            for (const file of files) {
                const relative = path.relative(moduleDir, file);

                if (relative === "automationAdapters.js") continue;

                // The shared role constants are part of the Identity contract.
                const source = read(file).replaceAll("../identity/identityConstants.js", "");

                assert.doesNotMatch(
                    source,
                    /from\s+["']\.\.\/(identity|leads|campaigns|delivery)\//,
                    `${relative} imports another module directly`
                );
            }
        });

        test("authentication comes from the shared middleware, not a copy", () => {
            for (const file of files) {
                assert.doesNotMatch(read(file), /from\s+["']jsonwebtoken["']/, path.relative(moduleDir, file));
            }
        });
    });

    describe("whole module with every neighbour mocked", () => {
        let server;
        let advisor;
        let campaign;
        const calls = [];

        before(async () => {
            await connectTestDatabase("contracts");

            const advisorId = randomObjectId();
            const campaignId = randomObjectId();
            const leadId = randomObjectId();
            const userId = randomObjectId();

            // No Identity, Campaign, Lead or Delivery module code is used.
            const adapters = {
                identity: {
                    findUser: async (id) => (id === userId ? { id: userId, role: "ADVISOR", isActive: true } : null),
                    getAdvisorIdForUser: async (id) => (id === userId ? advisorId : null),
                    getUserIdForAdvisor: async (id) => (id === advisorId ? userId : null),
                    hasAcceptedAssignment: async () => false,
                    listAcceptedAdvisorIds: async () => []
                },
                campaigns: {
                    findCampaign: async (id) =>
                        id === campaignId ? { id: campaignId, advisorId, status: "ACTIVE" } : null,
                    listSpecialistCampaignIds: async () => []
                },
                leads: {
                    findLead: async (id) => (id === leadId ? { id: leadId, advisorId } : null)
                },
                deliveryLookup: { findDeliveryJob: async () => null },
                delivery: createMockDelivery((request) => {
                    calls.push(request);

                    return { deliveryJobId: randomObjectId(), status: "PENDING" };
                }),
                metrics: {
                    leadMetrics: async () => ({ NEW: 5, CONVERTED: 2 }),
                    campaignMetrics: async () => ({ ACTIVE: 1 }),
                    deliveryMetrics: async () => ({ SENT: 3, FAILED: 1 })
                }
            };

            const context = createTestContext({ adapters });

            server = await startServer(context.app);
            advisor = { userId, advisorId, campaignId, leadId, token: null };
            campaign = campaignId;
        });

        after(async () => {
            await server.close();
            await disconnectTestDatabase();
        });

        test("rules, events, executions and analytics work against the contract alone", async () => {
            const { signToken } = await import("./helpers/automationTestKit.js");

            advisor.token = signToken({ userId: advisor.userId, role: "ADVISOR", advisorId: advisor.advisorId });

            const created = await server.request("POST", "/automations", {
                token: advisor.token,
                body: ruleBody({
                    name: "Mocked world",
                    trigger: "LEAD_CREATED",
                    action: "SEND_EMAIL",
                    campaignId: campaign,
                    enabled: true
                })
            });

            assert.equal(created.status, 201, JSON.stringify(created.body));

            const simulated = await server.request("POST", "/automations/simulate-event", {
                token: advisor.token,
                body: { eventId: "evt_mock_world", eventType: "LEAD_CREATED", entityId: advisor.leadId, metadata: { campaignId: campaign } }
            });

            assert.equal(simulated.status, 201, JSON.stringify(simulated.body));
            assert.equal(simulated.body.data.simulatedActions.length, 1);
            assert.equal(calls.length, 0, "simulation does not reach Delivery");

            const analytics = await server.request("GET", "/analytics/summary", { token: advisor.token });

            assert.equal(analytics.status, 200);
            assert.equal(analytics.body.data.business.leads.total, 7);
            assert.equal(analytics.body.data.business.leads.conversionRate, 28.57);
            assert.equal(analytics.body.data.business.deliveries.failed, 1);
        });

        test("campaignId must reference an existing Campaign._id", async () => {
            const unknown = await server.request("POST", "/automations", {
                token: advisor.token,
                body: ruleBody({ campaignId: randomObjectId() })
            });

            assert.equal(unknown.status, 404, "campaignId must reference an existing Campaign._id");
        });
    });
});
