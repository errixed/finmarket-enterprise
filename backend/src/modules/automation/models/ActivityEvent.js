import mongoose from "mongoose";
import {
    EVENT_TYPES,
    ENTITY_TYPES,
    EVENT_SOURCES,
    PROCESSING_STATUSES
} from "../automationConstants.js";

// Phase II: persisted in MongoDB (collection "activityEvents").
//
// Identifier conventions (see module README):
//   _id        -> MongoDB document id
//   eventId    -> application-level id used for de-duplication. It is NOT
//                 the same thing as _id.
//   ownerId    -> User._id of the advisor the event belongs to
//   entityId   -> id of the entity named by entityType (Lead._id,
//                 Campaign._id, DeliveryJob._id or AutomationRule._id)
//   campaignId -> Campaign._id when the event is about a campaign
//                 (derived by the server, used for specialist access)
const activityEventSchema = new mongoose.Schema(
    {
        eventId: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 100
        },

        eventType: {
            type: String,
            enum: EVENT_TYPES,
            required: true
        },

        entityId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true
        },

        entityType: {
            type: String,
            enum: ENTITY_TYPES,
            required: true
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

        occurredAt: {
            type: Date,
            default: Date.now
        },

        // Safe, small, non-sensitive data only. Validated on write.
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        },

        // SIMULATION events never execute real actions.
        source: {
            type: String,
            enum: EVENT_SOURCES,
            default: "INTERNAL"
        },

        // Processing metadata. Written only by the event service.
        processingStatus: {
            type: String,
            enum: PROCESSING_STATUSES,
            default: "RECEIVED"
        },

        processingStartedAt: {
            type: Date,
            default: null
        },

        processedAt: {
            type: Date,
            default: null
        },

        processingError: {
            type: String,
            maxlength: 300,
            default: null
        },

        matchedRuleCount: {
            type: Number,
            min: 0,
            default: 0
        }
    },
    {
        timestamps: true,
        collection: "activityEvents"
    }
);

// Duplicate event prevention. This index is what makes the same eventId
// impossible to store twice, even under concurrent requests.
activityEventSchema.index(
    { eventId: 1 },
    { unique: true }
);

activityEventSchema.index({
    eventType: 1,
    occurredAt: -1
});

activityEventSchema.index({
    ownerId: 1,
    occurredAt: -1
});

activityEventSchema.index({
    campaignId: 1,
    occurredAt: -1
});

activityEventSchema.index({
    entityType: 1,
    entityId: 1
});

activityEventSchema.index({
    processingStatus: 1,
    createdAt: 1
});

export default mongoose.model(
    "ActivityEvent",
    activityEventSchema
);
