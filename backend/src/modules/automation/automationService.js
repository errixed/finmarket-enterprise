import { randomUUID } from "node:crypto";
import AppError from "../../utils/AppError.js";
import { ROLES } from "../identity/identityConstants.js";
import automationRepository from "./automationRepository.js";
import { createDefaultAdapters } from "./automationAdapters.js";
import createExecutionService from "./automationExecutionService.js";
import createEventService from "./automationEventService.js";
import createAnalyticsService from "./automationAnalyticsService.js";
import {
    getActor,
    forbidden,
    requireRole,
    resolveScope,
    canViewRule,
    assertOwnerFilterAllowed
} from "./automationAccess.js";
import {
    parseRuleCreate,
    parseRuleUpdate,
    parseEvent,
    parseListQuery,
    assertRuleConsistency,
    isObjectIdString,
    redactMetadata,
    validationError
} from "./automationValidation.js";
import { SAMPLE_LEAD_ID } from "./automationConstants.js";

// Business rules for rules, simulated events and history. Controllers call
// this with the authenticated actor; nothing here trusts client-supplied
// ownership. All database access goes through the repository.

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

const stripVersion = ({ __v, ...rest }) => rest;

export const toPublicRule = (rule) => stripVersion(rule);

export const toPublicEvent = (event) => ({
    ...stripVersion(event),
    metadata: redactMetadata(event.metadata ?? {})
});

export const toPublicExecution = (execution) => stripVersion(execution);

// Same keys as the Phase I response so existing clients keep working.
export const toSimulatedAction = ({ execution, rule }) => ({
    ruleId: String(execution.automationRuleId),
    ruleName: rule?.name ?? null,
    action: execution.action,
    delayMinutes: rule?.delayMinutes ?? null,
    scheduledFor: execution.scheduledFor,
    status: execution.status
});

const pageInfo = ({ page, limit }, total) => ({
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit))
});

function requireObjectId(id, label = "id") {
    if (!isObjectIdString(id)) {
        throw validationError(`${label} must be a valid id.`);
    }

    return id.toLowerCase();
}

export function createAutomationService({
    repository = automationRepository,
    adapters = createDefaultAdapters(),
    clock = () => new Date(),
    env = process.env,
    executionService = createExecutionService({ repository, adapters, clock }),
    eventService = createEventService({ repository, adapters, executionService, clock }),
    analyticsService = createAnalyticsService({ repository, adapters, clock })
} = {}) {
    // The campaign must exist and belong to the advisor who owns the rule.
    // Campaign ownership is decided by the Campaigns data (advisorId), read
    // through the campaign adapter; it is not re-implemented here.
    async function assertCampaignUsable(campaignId, ownerAdvisorId) {
        const campaign = await adapters.campaigns.findCampaign(campaignId);

        if (!campaign) {
            throw new AppError("Campaign not found.", 404, "CAMPAIGN_NOT_FOUND");
        }

        if (campaign.advisorId !== ownerAdvisorId) {
            throw forbidden(
                "You are not authorized to use this campaign.",
                "CAMPAIGN_ACCESS_DENIED"
            );
        }
    }

    async function loadRule(id) {
        const ruleId = requireObjectId(id, "Rule id");
        const rule = await repository.findRuleById(ruleId);

        if (!rule) throw new AppError("Automation rule not found.", 404, "NOT_FOUND");

        return rule;
    }

    const service = {
        // POST /automations
        async createRule(actor, body) {
            requireRole(actor, [ROLES.ADVISOR], "Only advisors can create automation rules.");

            const { claimedOwnerId, data } = parseRuleCreate(body);

            // The owner is always the authenticated user. A submitted ownerId
            // is accepted only if it says the same thing.
            if (claimedOwnerId && claimedOwnerId !== actor.userId) {
                throw forbidden(
                    "ownerId must match the authenticated user.",
                    "OWNER_MISMATCH"
                );
            }

            const advisorId = await adapters.identity.getAdvisorIdForUser(actor.userId);

            if (!advisorId) {
                throw forbidden("An active advisor profile is required.", "ADVISOR_PROFILE_REQUIRED");
            }

            assertRuleConsistency(data);

            if (data.campaignId) {
                await assertCampaignUsable(data.campaignId, advisorId);
            }

            const rule = await repository.createRule({ ...data, ownerId: actor.userId });

            return toPublicRule(rule);
        },

        // GET /automations
        async listRules(actor, query) {
            const { filters, ...pagination } = parseListQuery(query, "rules");
            const scope = await resolveScope(actor, adapters);

            assertOwnerFilterAllowed(scope, filters);

            const { items, total } = await repository.listRules(scope, filters, pagination);

            return {
                items: items.map(toPublicRule),
                pagination: pageInfo(pagination, total)
            };
        },

        // GET /automations/:id
        async getRule(actor, id) {
            const rule = await loadRule(id);
            const scope = await resolveScope(actor, adapters);

            if (!canViewRule(scope, rule)) {
                throw forbidden("You do not have access to this automation rule.");
            }

            return toPublicRule(rule);
        },

        // PATCH /automations/:id
        async updateRule(actor, id, body) {
            const changes = parseRuleUpdate(body);
            const rule = await loadRule(id);

            if (actor.role === ROLES.ADVISOR) {
                if (String(rule.ownerId) !== actor.userId) {
                    throw forbidden("You can only change your own automation rules.");
                }
            } else if (actor.role === ROLES.MARKETING_SPECIALIST) {
                // Explicit permission only: the owner opted in, the specialist
                // has a relationship AND a campaign assignment, and the only
                // change is switching the rule on or off.
                const scope = await resolveScope(actor, adapters);
                const onlyEnabled =
                    Object.keys(changes).length === 1 && changes.enabled !== undefined;

                if (
                    !rule.allowSpecialistToggle ||
                    !canViewRule(scope, rule) ||
                    !onlyEnabled
                ) {
                    throw forbidden("You are not authorized to change this automation rule.");
                }
            } else {
                throw forbidden("Administrators have read-only access to automation rules.");
            }

            const merged = { ...rule, ...changes };

            assertRuleConsistency(merged);

            // Re-check the campaign whenever it changes or the rule is being
            // switched on, using the OWNER's advisor profile (the actor may
            // be a specialist).
            const campaignChanged =
                changes.campaignId !== undefined &&
                String(changes.campaignId ?? "") !== String(rule.campaignId ?? "");
            const enabling = changes.enabled === true && rule.enabled !== true;

            if (merged.campaignId && (campaignChanged || enabling)) {
                const ownerAdvisorId = await adapters.identity.getAdvisorIdForUser(String(rule.ownerId));

                if (!ownerAdvisorId) {
                    throw forbidden("The rule owner is not an active advisor.", "ADVISOR_PROFILE_REQUIRED");
                }

                await assertCampaignUsable(String(merged.campaignId), ownerAdvisorId);
            }

            const updated = await repository.updateRule(rule._id, changes);

            return toPublicRule(updated);
        },

        // POST /automations/simulate-event
        async simulateEvent(actor, body) {
            requireRole(actor, [ROLES.ADVISOR], "Only advisors can simulate events.");

            // Simulation is a testing tool. Off by default in production.
            if (env.NODE_ENV === "production" && env.AUTOMATION_SIMULATION_ENABLED !== "true") {
                throw forbidden("Event simulation is disabled.", "SIMULATION_DISABLED");
            }

            // Defaults reproduce the Phase I sample: a LEAD_CREATED event for
            // a sample lead. The owner always defaults to the caller.
            const event = parseEvent(body, {
                mode: "simulation",
                defaults: {
                    eventType: "LEAD_CREATED",
                    entityId: SAMPLE_LEAD_ID,
                    ownerId: actor.userId,
                    eventId: `evt_${randomUUID()}`
                }
            });

            // An untrusted client must never trigger another advisor's rules.
            if (event.ownerId !== actor.userId) {
                throw forbidden(
                    "You can only simulate events for your own account.",
                    "OWNER_MISMATCH"
                );
            }

            const result = await eventService.ingest(event, { source: "SIMULATION" });

            if (result.duplicate) {
                throw new AppError(
                    `Event ${event.eventId} was already processed.`,
                    409,
                    "EVENT_ALREADY_PROCESSED"
                );
            }

            return {
                event: toPublicEvent(result.event),
                simulatedActions: result.executions.map(toSimulatedAction)
            };
        },

        // GET /automations/events
        async listEvents(actor, query) {
            const { filters, ...pagination } = parseListQuery(query, "events");
            const scope = await resolveScope(actor, adapters);

            assertOwnerFilterAllowed(scope, filters);

            const { items, total } = await repository.listEvents(scope, filters, pagination);

            return {
                items: items.map(toPublicEvent),
                pagination: pageInfo(pagination, total)
            };
        },

        // GET /automations/executions
        async listExecutions(actor, query) {
            const { filters, ...pagination } = parseListQuery(query, "executions");
            const scope = await resolveScope(actor, adapters);

            assertOwnerFilterAllowed(scope, filters);

            const { items, total } = await repository.listExecutions(scope, filters, pagination);

            return {
                items: items.map(toPublicExecution),
                pagination: pageInfo(pagination, total)
            };
        },

        // GET /analytics/summary
        async getAnalyticsSummary(actor) {
            return analyticsService.getSummary(actor);
        },

        // Trusted internal API for other modules (not an HTTP route).
        publishEvent: (rawEvent) => eventService.publishEvent(rawEvent),

        // Run due scheduled actions once (used by the worker and tests).
        processDueExecutions: (options) => executionService.processDue(options)
    };

    return service;
}

export { getActor };
export default createAutomationService;
