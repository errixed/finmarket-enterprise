import { TRIGGER_ACTION_COMPATIBILITY } from "./automationConstants.js";

// Pure trigger-matching logic. No database, no clock, no side effects, so it
// can be unit tested on its own. Which rules to load is decided by the
// repository (enabled rules of the event owner for the event type); this
// file re-checks every condition so a rule is never trusted blindly.

const idOf = (value) => (value === null || value === undefined ? null : String(value));

export const isActionAllowedForTrigger = (trigger, action) =>
    TRIGGER_ACTION_COMPATIBILITY[trigger]?.includes(action) === true;

// A rule matches an event when all of these hold:
//  * the rule is enabled;
//  * the rule's trigger equals the event type;
//  * the rule belongs to the event's owner;
//  * if the rule is tied to a campaign, the event is about that campaign;
//  * the trigger/action pair is permitted (loop guard).
export function ruleMatchesEvent(rule, event) {
    if (rule.enabled !== true) return false;
    if (rule.trigger !== event.eventType) return false;
    if (idOf(rule.ownerId) !== idOf(event.ownerId)) return false;

    if (rule.campaignId && idOf(rule.campaignId) !== idOf(event.campaignId)) {
        return false;
    }

    return isActionAllowedForTrigger(rule.trigger, rule.action);
}

export const selectMatchingRules = (rules, event) =>
    rules.filter((rule) => ruleMatchesEvent(rule, event));

// When the action is due: the moment the event occurred plus the rule's
// delay. Never derived from the current time, so a restart or a late
// retry cannot shift the schedule.
export function calculateScheduledFor(event, rule) {
    const occurredAt = new Date(event.occurredAt);

    return new Date(occurredAt.getTime() + rule.delayMinutes * 60 * 1000);
}

// The execution record to store for one (event, rule) pair.
export function planExecution(rule, event, { simulated }) {
    return {
        eventId: event.eventId,
        automationRuleId: rule._id,
        idempotencyKey: `${event.eventId}:${rule._id}`,
        ownerId: rule.ownerId,
        campaignId: rule.campaignId ?? event.campaignId ?? null,
        trigger: rule.trigger,
        action: rule.action,
        entityType: event.entityType,
        entityId: event.entityId,
        simulated,
        status: simulated ? "SIMULATED" : "PENDING",
        scheduledFor: calculateScheduledFor(event, rule)
    };
}
