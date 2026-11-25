import mongoose from "mongoose";

export const DELIVERY_CHANNELS = Object.freeze(["EMAIL", "FACEBOOK"]);

export const DELIVERY_STATUSES = Object.freeze([
    "PENDING",
    "PROCESSING",
    "SENT",
    "FAILED",
    "CANCELLED"
]);

export const DELIVERY_PROVIDERS = Object.freeze([
    "MOCK_EMAIL",
    "MOCK_FACEBOOK",
    "GMAIL_SMTP",
    "META_FACEBOOK"
]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const deliveryJobSchema = new mongoose.Schema(
    {
        advisorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AdvisorProfile",
            required: true
        },

        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Campaign",
            required: true
        },

        leadId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Lead",
            default: null,
            required: function () {
                return this.channel === "EMAIL";
            }
        },

        createdByUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },

        channel: {
            type: String,
            enum: DELIVERY_CHANNELS,
            required: true
        },

        recipientEmail: {
            type: String,
            trim: true,
            lowercase: true,
            maxlength: 254,
            default: null,
            validate: {
                validator: (value) => value === null || EMAIL_REGEX.test(value),
                message: "recipientEmail must be a valid email address."
            }
        },

        content: {
            subject: {
                type: String,
                trim: true,
                maxlength: 200,
                default: ""
            },

            body: {
                type: String,
                trim: true,
                required: true,
                minlength: 1,
                maxlength: 10000
            }
        },

        deliveryStatus: {
            type: String,
            enum: DELIVERY_STATUSES,
            default: "PENDING"
        },

        provider: {
            type: String,
            enum: [...DELIVERY_PROVIDERS, null],
            default: null
        },

        scheduledAt: {
            type: Date,
            default: null
        },

        processingStartedAt: {
            type: Date,
            default: null
        },

        lastAttemptAt: {
            type: Date,
            default: null
        },

        sentAt: {
            type: Date,
            default: null
        },

        providerMessageId: {
            type: String,
            trim: true,
            maxlength: 255,
            default: null
        },

        attempts: {
            type: Number,
            min: 0,
            default: 0,
            alias: "attemptCount"
        },

        errorMessage: {
            type: String,
            trim: true,
            maxlength: 1000,
            default: null
        },

        idempotencyKey: {
            type: String,
            trim: true,
            maxlength: 128,
            default: null
        },

        simulated: {
            type: Boolean,
            default: true
        }
    },
    {
        timestamps: true,
        collection: "deliveryJobs"
    }
);

deliveryJobSchema.index({ advisorId: 1, createdAt: -1 });
deliveryJobSchema.index({ advisorId: 1, deliveryStatus: 1, createdAt: -1 });
deliveryJobSchema.index({ campaignId: 1, deliveryStatus: 1 });
deliveryJobSchema.index({ deliveryStatus: 1, scheduledAt: 1 });
deliveryJobSchema.index({ leadId: 1, campaignId: 1 });
deliveryJobSchema.index(
    { idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            idempotencyKey: { $type: "string" }
        }
    }
);

export default mongoose.model("DeliveryJob", deliveryJobSchema);