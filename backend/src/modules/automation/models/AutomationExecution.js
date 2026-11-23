import mongoose from "mongoose";
import {
    ACTIONS,
    TRIGGERS,
    ENTITY_TYPES,
    EXECUTION_STATUSES
} from "../automationConstants.js";

// New in Phase II (collection "automationExecutions", owned by Member 5).
//
// One document records "rule R reacted to event E". It is both:
//   * the durable execution identity: the unique index on
//     (eventId, automationRuleId) means a rule can run at most once per
//     event, even with duplicate submissions, concurrent workers or a
//     restart in the middle of processing;
//   * the persistent schedule: a delayed action is a PENDING execution with
//     a future scheduledFor. No timers or in-memory state are involved.
const automationExecutionSchema = new mongoose.Schema(
    {
        // ActivityEvent.eventId (NOT ActivityEvent._id).
        eventId: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100
        },

        automationRuleId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AutomationRule",
            required: true
        },

        // "<eventId>:<automationRuleId>". Passed to Delivery so it can
        // de-duplicate on its side as well.
        idempotencyKey: {
            type: String,
            required: true,
            maxlength: 160
        },

        ownerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Campaign",
            default: null
        },

        trigger: {
            type: String,
            enum: TRIGGERS,
            required: true
        },

        action: {
            type: String,
            enum: ACTIONS,
            required: true
        },

        entityType: {
            type: String,
            enum: ENTITY_TYPES,
            required: true
        },

        entityId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true
        },

        // True for executions created by a simulated event. They are never
        // picked up by the worker and never call an adapter.
        simulated: {
            type: Boolean,
            default: false
        },

        status: {
            type: String,
            enum: EXECUTION_STATUSES,
            required: true,
            default: "PENDING"
        },

        // occurredAt + delayMinutes. Nothing runs before this time.
        scheduledFor: {
            type: Date,
            required: true
        },

        attemptCount: {
            type: Number,
            min: 0,
            default: 0
        },

        lockedBy: {
            type: String,
            maxlength: 100,
            default: null
        },

        lockedAt: {
            type: Date,
            default: null
        },

        lastAttemptAt: {
            type: Date,
            default: null
        },

        completedAt: {
            type: Date,
            default: null
        },

        // Safe outcome data, for example { deliveryJobId }.
        result: {
            type: mongoose.Schema.Types.Mixed,
            default: null
        },

        error: {
            code: {
                type: String,
                maxlength: 60,
                default: null
            },
            message: {
                type: String,
                maxlength: 300,
                default: null
            }
        }
    },
    {
        timestamps: true,
        collection: "automationExecutions"
    }
);

// Duplicate execution prevention: one execution per (event, rule).
automationExecutionSchema.index(
    { eventId: 1, automationRuleId: 1 },
    { unique: true }
);

// Finding work that is due.
automationExecutionSchema.index({
    status: 1,
    scheduledFor: 1
});

automationExecutionSchema.index({
    ownerId: 1,
    createdAt: -1
});

automationExecutionSchema.index({
    campaignId: 1,
    createdAt: -1
});

automationExecutionSchema.index({
    automationRuleId: 1,
    createdAt: -1
});

export default mongoose.model(
    "AutomationExecution",
    automationExecutionSchema
);
