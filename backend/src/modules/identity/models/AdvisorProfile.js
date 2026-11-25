import mongoose from "mongoose";
import { CONSULTATION_TYPES } from "../identityConstants.js";

const advisorProfileSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            immutable: true
        },

        specialties: {
            type: [{
                type: String,
                trim: true,
                required: true
            }],
            default: []
        },

        consultationTypes: {
            type: [{
                type: String,
                enum: CONSULTATION_TYPES
            }],
            default: []
        },

        bio: {
            type: String,
            trim: true,
            maxlength: 1000,
            default: ""
        },

        isPublic: {
            type: Boolean,
            default: false,
            required: true
        }
    },
    {
        timestamps: true,
        collection: "advisorProfiles",
        versionKey: false,
        toJSON: {
            virtuals: true
        }
    }
);

advisorProfileSchema.index(
    { userId: 1 },
    { unique: true }
);

advisorProfileSchema.index({
    isPublic: 1,
    createdAt: -1
});

export default mongoose.model(
    "AdvisorProfile",
    advisorProfileSchema
);