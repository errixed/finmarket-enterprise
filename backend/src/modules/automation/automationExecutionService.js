import { randomUUID } from "node:crypto";
import automationRepository from "./automationRepository.js";
import { createDefaultAdapters } from "./automationAdapters.js";
import {
    RETRY_POLICY,
    DEFAULT_EMAIL_CONTENT,
    DELIVERY_ACTIONS
} from "./automationConstants.js";

// Runs automation actions that have been matched and persisted as
// AutomationExecution documents. It is used both right after an event is
// processed (for actions with no delay) and by the polling worker (for
// delayed actions such as follow-ups).
//
// Safety properties:
//  * an execution is claimed atomically (PENDING -> PROCESSING), so two
//    workers or two requests can never run the same action;
//  * the rule is re-checked at run time, so disabling a rule cancels
//    anything not yet run;
//  * Delivery is reached only through the delivery adapter, which carries an
//    idempotency key; Automation never sends email itself;
//  * an action whose outcome is unknown is never repeated automatically.

const safeMessage = (error) =>
    String(error?.message ?? "Unknown error").slice(0, 300);

export function createExecutionService({
    repository = automationRepository,
    adapters = createDefaultAdapters(),
    clock = () => new Date(),
    workerId = `worker_${randomUUID().slice(0, 8)}`,
    retry = RETRY_POLICY
} = {}) {
    async function recordAuditEvent(execution, rule, outcome) {
        // Audit trail only. AUTOMATION_* events can never trigger a rule, so
        // this cannot start a processing loop. A failure here must not change
        // the outcome of the action.
        try {
            await repository.createEvent({
                eventId: `auto_${execution._id}`,
                eventType: outcome === "COMPLETED" ? "AUTOMATION_EXECUTED" : "AUTOMATION_FAILED",
                entityType: "AUTOMATION_RULE",
                entityId: execution.automationRuleId,
                ownerId: execution.ownerId,
                campaignId: execution.campaignId ?? null,
                source: "INTERNAL",
                occurredAt: clock(),
                processingStatus: "PROCESSED",
                processedAt: clock(),
                metadata: {
                    executionId: String(execution._id),
                    sourceEventId: execution.eventId,
                    action: execution.action,
                    outcome
                }
            });
        } catch (error) {
            console.error("Automation audit event failed:", safeMessage(error));
        }
    }

    async function finish(execution, rule, outcome) {
        const now = clock();
        const done = await repository.finishExecution(execution._id, workerId, {
            ...outcome,
            now
        });

        if (done && outcome.status === "COMPLETED") {
            await repository.markRuleExecuted(execution.automationRuleId, now);
        }

        if (done && ["COMPLETED", "FAILED", "UNCERTAIN"].includes(outcome.status)) {
            await recordAuditEvent(done, rule, outcome.status);
        }

        return done;
    }

    function classifyDeliveryError(error, attemptCount) {
        const status = error?.statusCode;

        // Delivery (or the provider) is temporarily unavailable and nothing
        // was queued: safe to retry later.
        if (error?.retryable === true || status === 503) {
            if (attemptCount >= retry.maxAttempts) {
                return {
                    kind: "FAILED",
                    code: "RETRIES_EXHAUSTED",
                    message: `Delivery unavailable after ${attemptCount} attempts.`
                };
            }

            return {
                kind: "RETRY",
                code: error.code ?? "DELIVERY_UNAVAILABLE",
                message: safeMessage(error),
                delayMs: retry.baseDelayMs * 2 ** (attemptCount - 1)
            };
        }

        // Delivery refused the request (consent, campaign state, validation):
        // a definite answer, retrying would give the same answer.
        if (Number.isInteger(status) && status >= 400 && status < 500) {
            return {
                kind: "FAILED",
                code: error.code ?? "DELIVERY_REJECTED",
                message: safeMessage(error)
            };
        }

        // Anything else: we cannot know whether a job was queued, so it is
        // not retried automatically.
        return {
            kind: "UNCERTAIN",
            code: "OUTCOME_UNKNOWN",
            message: safeMessage(error)
        };
    }

    async function performAction(execution, rule, ownerAdvisorId) {
        if (execution.action === "CREATE_NOTIFICATION") {
            // No notification service exists yet. The notification is the
            // recorded execution itself, readable through the executions
            // endpoint. No external side effect.
            return { notification: "RECORDED" };
        }

        if (!DELIVERY_ACTIONS.includes(execution.action)) {
            throw Object.assign(new Error("Unsupported action."), { statusCode: 400, code: "UNSUPPORTED_ACTION" });
        }

        const defaults = DEFAULT_EMAIL_CONTENT[execution.action];

        const result = await adapters.delivery.requestDelivery({
            idempotencyKey: execution.idempotencyKey,
            source: "AUTOMATION",
            automationRuleId: String(execution.automationRuleId),
            eventId: execution.eventId,
            advisorId: ownerAdvisorId,
            campaignId: String(rule.campaignId),
            leadId: execution.entityType === "LEAD" ? String(execution.entityId) : null,
            channel: "EMAIL",
            content: {
                subject: rule.actionConfig?.subject || defaults.subject,
                body: rule.actionConfig?.body || defaults.body
            },
            scheduledAt: execution.scheduledFor
        });

        return {
            deliveryJobId: result.deliveryJobId,
            deliveryStatus: result.status ?? null
        };
    }

    // Claims and runs one execution. Returns the stored execution, or null
    // when it was not claimable (not due yet, already taken, or finished).
    async function runExecutionById(executionId) {
        const now = clock();
        const execution = await repository.claimExecution(executionId, workerId, now);

        if (!execution) return null;

        const rule = await repository.findRuleById(execution.automationRuleId);

        if (!rule) {
            return finish(execution, null, {
                status: "SKIPPED",
                error: { code: "RULE_NOT_FOUND", message: "The rule no longer exists." }
            });
        }

        // Disabled rules are never executed, even if the execution was
        // created while the rule was still enabled.
        if (!rule.enabled) {
            return finish(execution, rule, {
                status: "SKIPPED",
                error: { code: "RULE_DISABLED", message: "The rule was disabled before it ran." }
            });
        }

        const ownerAdvisorId = await adapters.identity.getAdvisorIdForUser(String(rule.ownerId));

        if (!ownerAdvisorId) {
            return finish(execution, rule, {
                status: "SKIPPED",
                error: { code: "OWNER_UNAVAILABLE", message: "The rule owner is no longer an active advisor." }
            });
        }

        if (rule.campaignId) {
            const campaign = await adapters.campaigns.findCampaign(String(rule.campaignId));

            if (!campaign || campaign.advisorId !== ownerAdvisorId) {
                return finish(execution, rule, {
                    status: "FAILED",
                    error: { code: "CAMPAIGN_UNAVAILABLE", message: "The campaign is missing or no longer belongs to the rule owner." }
                });
            }
        }

        try {
            const result = await performAction(execution, rule, ownerAdvisorId);

            return await finish(execution, rule, { status: "COMPLETED", result });
        } catch (error) {
            const verdict = classifyDeliveryError(error, execution.attemptCount);

            if (verdict.kind === "RETRY") {
                return repository.scheduleRetry(execution._id, workerId, {
                    scheduledFor: new Date(now.getTime() + verdict.delayMs),
                    error: { code: verdict.code, message: verdict.message }
                });
            }

            return finish(execution, rule, {
                status: verdict.kind,
                error: { code: verdict.code, message: verdict.message }
            });
        }
    }

    // One worker pass: mark abandoned work, then run what is due. Safe to
    // call from several processes at once because every run starts with an
    // atomic claim.
    async function processDue({ limit = 25 } = {}) {
        const now = clock();
        const uncertain = await repository.markStaleExecutionsUncertain(now, retry.leaseMs);
        const ids = await repository.findDueExecutionIds(now, limit);

        const summary = { uncertain, due: ids.length, claimed: 0 };

        for (const id of ids) {
            const result = await runExecutionById(id);

            if (result) summary.claimed += 1;
        }

        return summary;
    }

    return { runExecutionById, processDue, workerId };
}

export default createExecutionService;
