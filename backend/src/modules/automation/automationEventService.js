import automationRepository from "./automationRepository.js";
import { createDefaultAdapters } from "./automationAdapters.js";
import createExecutionService from "./automationExecutionService.js";
import { forbidden } from "./automationAccess.js";
import { selectMatchingRules, planExecution } from "./eventProcessor.js";
import { parseEvent } from "./automationValidation.js";
import AppError from "../../utils/AppError.js";
import { RETRY_POLICY } from "./automationConstants.js";

// Event processing: validate -> verify owner and entity -> persist (with
// duplicate prevention) -> match rules -> record one execution per matching
// rule -> run the actions that are due.
//
// Two entry points share this code:
//   * the simulation endpoint (source SIMULATION, never calls Delivery);
//   * publishEvent(), the trusted internal API other modules call after a
//     lead, campaign or delivery operation (source INTERNAL).

export function createEventService({
    repository = automationRepository,
    adapters = createDefaultAdapters(),
    executionService = createExecutionService({ repository, adapters }),
    clock = () => new Date(),
    leaseMs = RETRY_POLICY.leaseMs
} = {}) {
    // The owner must be an active advisor. Returns the advisor's
    // AdvisorProfile id, used to check that referenced entities belong to
    // the same advisor.
    async function resolveOwnerAdvisor(event, source) {
        const advisorId = await adapters.identity.getAdvisorIdForUser(event.ownerId);

        if (!advisorId) {
            throw source === "SIMULATION"
                ? forbidden("An active advisor profile is required.", "ADVISOR_PROFILE_REQUIRED")
                : new AppError("ownerId must reference an active advisor.", 400, "INVALID_OWNER");
        }

        return advisorId;
    }

    async function assertCampaignOwnedBy(campaignId, advisorId) {
        const campaign = await adapters.campaigns.findCampaign(campaignId);

        if (!campaign) throw new AppError("Campaign not found.", 404, "ENTITY_NOT_FOUND");

        if (campaign.advisorId !== advisorId) {
            throw forbidden("The campaign does not belong to the event owner.", "ENTITY_ACCESS_DENIED");
        }
    }

    // Invalid references are rejected. A simulated event may name a lead or
    // delivery job that does not exist yet (the guide's sample leadId); it is
    // still rejected if the entity exists and belongs to someone else.
    async function verifyEntity(event, advisorId, source) {
        const allowUnverified = source === "SIMULATION";

        if (event.entityType === "CAMPAIGN") {
            await assertCampaignOwnedBy(event.entityId, advisorId);
        } else {
            const lookup =
                event.entityType === "LEAD"
                    ? await adapters.leads.findLead(event.entityId)
                    : event.entityType === "DELIVERY_JOB"
                        ? await adapters.deliveries.findDeliveryJob(event.entityId)
                        : null;

            if (!lookup) {
                if (!allowUnverified) {
                    throw new AppError(`${event.entityType} not found.`, 404, "ENTITY_NOT_FOUND");
                }
            } else if (lookup.advisorId !== advisorId) {
                throw forbidden("The referenced record does not belong to the event owner.", "ENTITY_ACCESS_DENIED");
            }
        }

        // A campaign named in metadata becomes the event's campaignId, which
        // also controls specialist visibility, so it must belong to the owner.
        if (event.entityType !== "CAMPAIGN" && event.campaignId) {
            await assertCampaignOwnedBy(event.campaignId, advisorId);
        }
    }

    async function processClaimed(event, { duplicate }) {
        const simulated = event.source === "SIMULATION";

        try {
            const candidates = await repository.findEnabledRulesForEvent({
                ownerId: String(event.ownerId),
                trigger: event.eventType,
                campaignId: event.campaignId ? String(event.campaignId) : null
            });
            const rules = selectMatchingRules(candidates, event);

            for (const rule of rules) {
                // Idempotent: the unique (eventId, rule) index decides.
                await repository.createExecution(planExecution(rule, event, { simulated }));
            }

            const processed = await repository.markEventProcessed(event.eventId, {
                matchedRuleCount: rules.length,
                now: clock()
            });

            // Run what is due now. Anything delayed stays PENDING in the
            // database and is picked up by the worker.
            if (!simulated) {
                const pending = await repository.listExecutionsForEvent(event.eventId);

                for (const execution of pending) {
                    if (
                        execution.status === "PENDING" &&
                        new Date(execution.scheduledFor) <= clock()
                    ) {
                        await executionService.runExecutionById(execution._id);
                    }
                }
            }

            const executions = await repository.listExecutionsForEvent(event.eventId);
            const ruleById = new Map(rules.map((rule) => [String(rule._id), rule]));

            return {
                event: processed,
                duplicate,
                executions: executions.map((execution) => ({
                    execution,
                    rule: ruleById.get(String(execution.automationRuleId)) ?? null
                }))
            };
        } catch (error) {
            await repository.markEventFailed(event.eventId, error?.message ?? "Processing failed.");
            throw error;
        }
    }

    // `event` must already be parsed with parseEvent().
    async function ingest(event, { source }) {
        const advisorId = await resolveOwnerAdvisor(event, source);
        await verifyEntity(event, advisorId, source);

        const now = clock();
        const stored = await repository.createEvent({
            ...event,
            source,
            occurredAt: event.occurredAt ?? now,
            processingStatus: "RECEIVED"
        });

        if (stored.created) {
            const claimed = await repository.claimEventForProcessing(event.eventId, now, leaseMs);

            return processClaimed(claimed ?? stored.event, { duplicate: false });
        }

        // Same eventId submitted again: never stored twice. A trusted event
        // that was interrupted (backend restart) is resumed; this is safe
        // because executions are idempotent. Anything else is a plain
        // duplicate and nothing is processed.
        if (source === "INTERNAL" && stored.event.source === "INTERNAL") {
            const resumed = await repository.claimEventForProcessing(event.eventId, now, leaseMs);

            if (resumed) return processClaimed(resumed, { duplicate: true });
        }

        const executions = await repository.listExecutionsForEvent(event.eventId);

        return {
            event: stored.event,
            duplicate: true,
            executions: executions.map((execution) => ({ execution, rule: null }))
        };
    }

    // Trusted internal entry point for the Leads, Campaigns and Delivery
    // modules. ownerId is supplied by backend code that already knows the
    // owner; it is still verified here. Never expose this directly to HTTP.
    async function publishEvent(rawEvent) {
        const event = parseEvent(rawEvent, { mode: "internal" });

        return ingest(event, { source: "INTERNAL" });
    }

    return { ingest, publishEvent };
}

export default createEventService;
