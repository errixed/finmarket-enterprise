import automationRepository from "./automationRepository.js";
import { createDefaultAdapters } from "./automationAdapters.js";
import { ROLES } from "../identity/identityConstants.js";
import { resolveScope } from "./automationAccess.js";

// Analytics summary. Every number is computed by MongoDB (count and
// aggregation queries); no collection is loaded into memory.
//
// Metric definitions (also in the README):
//   rules.*                  AutomationRules in the caller's scope
//   events.*                 ActivityEvents in scope; withMatchingRules is the
//                            number of events that matched at least one rule
//   simulatedActions.*       executions created by simulated events
//   executedActions.*        executions created by real events, by status
//   business.leads           Lead counts by status (not shown to specialists)
//   business.campaigns       Campaign counts by status
//   business.deliveries      DeliveryJob counts by status
//   conversionRate           converted / total leads * 100, rounded to two
//                            decimals; 0 when there are no leads

const sum = (map) => Object.values(map).reduce((total, value) => total + value, 0);

const percent = (part, whole) =>
    whole === 0 ? 0 : Math.round((part / whole) * 10000) / 100;

function shapeLeads(byStatus) {
    const total = sum(byStatus);
    const converted = byStatus.CONVERTED ?? 0;

    return {
        total,
        byStatus,
        consultationRequests: byStatus.CONSULTATION_REQUESTED ?? 0,
        converted,
        conversionRate: percent(converted, total)
    };
}

const shapeCampaigns = (byStatus) => ({
    total: sum(byStatus),
    byStatus,
    active: byStatus.ACTIVE ?? 0,
    completed: byStatus.COMPLETED ?? 0
});

const shapeDeliveries = (byStatus) => ({
    total: sum(byStatus),
    byStatus,
    sent: byStatus.SENT ?? 0,
    failed: byStatus.FAILED ?? 0
});

export function createAnalyticsService({
    repository = automationRepository,
    adapters = createDefaultAdapters(),
    clock = () => new Date()
} = {}) {
    async function businessMetrics(actor, scope) {
        if (actor.role === ROLES.ADMIN) {
            const [leads, campaigns, deliveries] = await Promise.all([
                adapters.metrics.leadMetrics({}),
                adapters.metrics.campaignMetrics({}),
                adapters.metrics.deliveryMetrics({})
            ]);

            return {
                leads: shapeLeads(leads),
                campaigns: shapeCampaigns(campaigns),
                deliveries: shapeDeliveries(deliveries)
            };
        }

        if (actor.role === ROLES.ADVISOR) {
            const advisorId =
                actor.advisorId ?? await adapters.identity.getAdvisorIdForUser(actor.userId);

            if (!advisorId) {
                return {
                    leads: shapeLeads({}),
                    campaigns: shapeCampaigns({}),
                    deliveries: shapeDeliveries({})
                };
            }

            const [leads, campaigns, deliveries] = await Promise.all([
                adapters.metrics.leadMetrics({ advisorId }),
                adapters.metrics.campaignMetrics({ advisorId }),
                adapters.metrics.deliveryMetrics({ advisorId })
            ]);

            return {
                leads: shapeLeads(leads),
                campaigns: shapeCampaigns(campaigns),
                deliveries: shapeDeliveries(deliveries)
            };
        }

        // Marketing Specialist: only the campaigns they are assigned to, and
        // no lead data at all (leads carry contact information that belongs
        // to the advisor).
        const [campaigns, deliveries] = await Promise.all([
            adapters.metrics.campaignMetrics({ campaignIds: scope.campaignIds }),
            adapters.metrics.deliveryMetrics({ campaignIds: scope.campaignIds })
        ]);

        return {
            leads: null,
            campaigns: shapeCampaigns(campaigns),
            deliveries: shapeDeliveries(deliveries)
        };
    }

    return {
        async getSummary(actor) {
            const scope = await resolveScope(actor, adapters);

            const [rules, events, executions, business] = await Promise.all([
                repository.summarizeRules(scope),
                repository.summarizeEvents(scope),
                repository.summarizeExecutions(scope),
                businessMetrics(actor, scope)
            ]);

            return {
                scope: {
                    role: actor.role,
                    level:
                        scope.kind === "ALL"
                            ? "PLATFORM"
                            : scope.kind === "OWNER"
                                ? "OWN_RESOURCES"
                                : "ASSIGNED_CAMPAIGNS",
                    ...(scope.kind === "CAMPAIGNS"
                        ? { campaignCount: scope.campaignIds.length }
                        : {})
                },
                rules,
                events,
                simulatedActions: executions.simulated,
                executedActions: executions.executed,
                business,
                generatedAt: clock().toISOString()
            };
        }
    };
}

export default createAnalyticsService;
