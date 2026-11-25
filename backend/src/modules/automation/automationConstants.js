// Shared constants for the Automation & Analytics module (Member 5).
// Models, validation, services and tests all read the same lists, so the
// allowed values can never drift apart.

// Triggers a rule may react to. The first four are the Phase I values and are
// preserved; the rest come from the shared event contract.
export const TRIGGERS = Object.freeze([
    "LEAD_CREATED",
    "LEAD_STATUS_CHANGED",
    "CONSULTATION_REQUESTED",
    "CAMPAIGN_ACTIVATED",
    "CAMPAIGN_CREATED",
    "CAMPAIGN_COMPLETED",
    "DELIVERY_QUEUED",
    "DELIVERY_SENT",
    "DELIVERY_FAILED"
]);

export const ACTIONS = Object.freeze([
    "SEND_EMAIL",
    "SCHEDULE_FOLLOW_UP",
    "CREATE_NOTIFICATION"
]);

// Actions that ask the Delivery module to queue a message.
export const DELIVERY_ACTIONS = Object.freeze([
    "SEND_EMAIL",
    "SCHEDULE_FOLLOW_UP"
]);

// Event types that may be published. Types after DELIVERY_FAILED are written
// by this module itself as an audit trail and can never trigger a rule.
export const EVENT_TYPES = Object.freeze([
    ...TRIGGERS,
    "AUTOMATION_EXECUTED",
    "AUTOMATION_FAILED"
]);

export const ENTITY_TYPES = Object.freeze([
    "LEAD",
    "CAMPAIGN",
    "DELIVERY_JOB",
    "AUTOMATION_RULE"
]);

// "DELIVERY" is the name used in the Phase II guide; it is stored as
// DELIVERY_JOB so Phase I data and Phase II data use one value.
export const ENTITY_TYPE_ALIASES = Object.freeze({
    DELIVERY: "DELIVERY_JOB"
});

// Which entity an event type is about. An event whose entityType does not
// match its eventType is rejected.
export const EVENT_ENTITY_TYPE = Object.freeze({
    LEAD_CREATED: "LEAD",
    LEAD_STATUS_CHANGED: "LEAD",
    CONSULTATION_REQUESTED: "LEAD",
    CAMPAIGN_CREATED: "CAMPAIGN",
    CAMPAIGN_ACTIVATED: "CAMPAIGN",
    CAMPAIGN_COMPLETED: "CAMPAIGN",
    DELIVERY_QUEUED: "DELIVERY_JOB",
    DELIVERY_SENT: "DELIVERY_JOB",
    DELIVERY_FAILED: "DELIVERY_JOB",
    AUTOMATION_EXECUTED: "AUTOMATION_RULE",
    AUTOMATION_FAILED: "AUTOMATION_RULE"
});

// Permitted trigger -> action combinations. This is the loop guard:
//  * email-style actions only react to Lead events (they need a lead and
//    Delivery's consent checks);
//  * Campaign and Delivery events can only create notifications, so a
//    DELIVERY_QUEUED event can never queue another delivery.
const LEAD_TRIGGERS = ["LEAD_CREATED", "LEAD_STATUS_CHANGED", "CONSULTATION_REQUESTED"];
const NOTIFY_ONLY_TRIGGERS = TRIGGERS.filter(
    (trigger) => !LEAD_TRIGGERS.includes(trigger)
);

export const TRIGGER_ACTION_COMPATIBILITY = Object.freeze({
    ...Object.fromEntries(LEAD_TRIGGERS.map((trigger) => [trigger, [...ACTIONS]])),
    ...Object.fromEntries(
        NOTIFY_ONLY_TRIGGERS.map((trigger) => [trigger, ["CREATE_NOTIFICATION"]])
    )
});

export const EVENT_SOURCES = Object.freeze(["SIMULATION", "INTERNAL"]);

export const PROCESSING_STATUSES = Object.freeze([
    "RECEIVED",
    "PROCESSING",
    "PROCESSED",
    "FAILED"
]);

export const EXECUTION_STATUSES = Object.freeze([
    "PENDING",     // waiting for scheduledFor
    "PROCESSING",  // claimed by one worker
    "COMPLETED",
    "FAILED",      // definite failure, will not be retried
    "UNCERTAIN",   // outcome unknown, never retried automatically
    "SKIPPED",     // rule disabled/removed or access lost before running
    "SIMULATED"    // created by a simulated event, never executed
]);

export const EXECUTION_FINAL_STATUSES = Object.freeze([
    "COMPLETED",
    "FAILED",
    "UNCERTAIN",
    "SKIPPED",
    "SIMULATED"
]);

// Documented retry policy (see README):
//  * a definite, retryable failure is retried up to maxAttempts with
//    exponential back-off;
//  * a definite, non-retryable failure is final;
//  * an unknown outcome is never retried automatically.
export const RETRY_POLICY = Object.freeze({
    maxAttempts: 3,
    baseDelayMs: 5 * 60 * 1000,
    leaseMs: 5 * 60 * 1000
});

export const DELAY_MINUTES_MAX = 43200;

export const DEFAULT_EMAIL_CONTENT = Object.freeze({
    SEND_EMAIL: Object.freeze({
        subject: "Thank you for your interest",
        body: "Thank you for getting in touch. Your advisor will be in contact soon."
    }),
    SCHEDULE_FOLLOW_UP: Object.freeze({
        subject: "Following up",
        body: "We wanted to follow up on your recent enquiry. Reply to this message if you would like to talk."
    })
});

export const PAGINATION = Object.freeze({
    defaultLimit: 20,
    maxLimit: 100
});

// Sample identifiers used by the simulation endpoint when none are given.
export const SAMPLE_LEAD_ID = "665f1c2a9b1e8a0012a4c101";
