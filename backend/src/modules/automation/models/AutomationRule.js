import mongoose from "mongoose";
import {
    TRIGGERS,
    ACTIONS,
    DELAY_MINUTES_MAX
} from "../automationConstants.js";

// Phase II: persisted in MongoDB (collection "automationRules").
//
// Identifier conventions (see module README):
//   ownerId    -> User._id of the advisor who owns the rule
//   campaignId -> Campaign._id (optional)
//
// Phase I fields and enum values are preserved. New fields:
//   actionConfig, allowSpecialistToggle, executionCount.
const automationRuleSchema = new mongoose.Schema(
    {
        ownerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 3,
            maxlength: 150
        },

        description: {
            type: String,
            trim: true,
            maxlength: 1000,
            default: ""
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

        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Campaign",
            default: null
        },

        delayMinutes: {
            type: Number,
            min: 0,
            max: DELAY_MINUTES_MAX,
            default: 0,
            validate: {
                validator: Number.isInteger,
                message: "Delay must be a whole number."
            }
        },

        enabled: {
            type: Boolean,
            default: false
        },

        // Optional message content for email actions. Safe defaults are used
        // when empty. Delivery still validates everything.
        actionConfig: {
            subject: {
                type: String,
                trim: true,
                maxlength: 200,
                default: ""
            },
            body: {
                type: String,
                trim: true,
                maxlength: 10000,
                default: ""
            }
        },

        // Explicit permission: when true, a Marketing Specialist who has an
        // accepted relationship AND a campaign assignment may switch this
        // rule on or off. Only the owner can change this flag.
        allowSpecialistToggle: {
            type: Boolean,
            default: false
        },

        // Execution metadata. Written only by the execution service.
        lastExecutedAt: {
            type: Date,
            default: null
        },

        executionCount: {
            type: Number,
            min: 0,
            default: 0
        }
    },
    {
        timestamps: true,
        collection: "automationRules"
    }
);

automationRuleSchema.index({
    ownerId: 1,
    enabled: 1
});

automationRuleSchema.index({
    trigger: 1,
    enabled: 1
});

// Used when an event arrives: enabled rules for one owner and trigger.
automationRuleSchema.index({
    ownerId: 1,
    trigger: 1,
    enabled: 1,
    campaignId: 1
});

automationRuleSchema.index({
    campaignId: 1,
    createdAt: -1
});

automationRuleSchema.index({
    ownerId: 1,
    createdAt: -1
});

export default mongoose.model(
    "AutomationRule",
    automationRuleSchema
);
