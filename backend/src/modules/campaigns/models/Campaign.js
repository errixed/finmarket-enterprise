import mongoose from "mongoose";

const campaignSchema = new mongoose.Schema(
    {
        advisorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AdvisorProfile",
            immutable: true,
            required: true
        },

        title: {
            type: String,
            required: true,
            trim: true,
            minlength: 3,
            maxlength: 150
        },

        description: {
            type: String,
            trim: true,
            maxlength: 2000,
            default: ""
        },

        strategy: {
            type: String,
            enum: [
                "NEWSLETTER",
                "RETIREMENT_PLANNING",
                "INVESTMENT_EDUCATION",
                "WEBINAR",
                "CONSULTATION_OFFER",
                "OTHER"
            ],
            required: true
        },

        channel: {
            type: String,
            enum: [
                "EMAIL",
                "FACEBOOK"
            ],
            required: true
        },

        audience: {
            interests: {
                type: [String],
                default: []
            },
            leadStatuses: {
                type: [String],
                enum: [
                    "NEW",
                    "CONTACTED",
                    "CONSULTATION_REQUESTED",
                    "CONVERTED"
                ],
                default: []
            }
        },

        templateId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Template",
            default: null
        },

        assignedSpecialistIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
            default: [],
            validate: ids => new Set(ids.map(String)).size === ids.length
        },

        status: {
            type: String,
            enum: [
                "DRAFT",
                "SCHEDULED",
                "ACTIVE",
                "COMPLETED",
                "CANCELLED"
            ],
            default: "DRAFT"
        },

        scheduledAt: {
            type: Date,
            default: null
        },

        completedAt: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: true,
        collection: "campaigns"
    }
);

campaignSchema.index({ advisorId: 1, status: 1 });
campaignSchema.index({ scheduledAt: 1 });
campaignSchema.index({ assignedSpecialistIds: 1, advisorId: 1 });

export default mongoose.model(
    "Campaign",
    campaignSchema
);