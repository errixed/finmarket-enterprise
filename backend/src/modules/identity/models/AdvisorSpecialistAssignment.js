import mongoose from "mongoose";
import { ASSIGNMENT_STATUSES } from "../identityConstants.js";

const assignmentSchema = new mongoose.Schema(
    {
        advisorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AdvisorProfile",
            required: true,
            immutable: true
        },

        specialistUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            immutable: true
        },

        status: {
            type: String,
            enum: Object.values(ASSIGNMENT_STATUSES),
            default: ASSIGNMENT_STATUSES.PENDING,
            required: true
        },

        acceptedAt: {
            type: Date,
            default: null
        },

        revokedAt: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: true,
        collection: "advisorSpecialistAssignments",
        versionKey: false,
        toJSON: {
            virtuals: true
        }
    }
);

assignmentSchema.index(
    {
        advisorId: 1,
        specialistUserId: 1
    },
    {
        unique: true,
        partialFilterExpression: {
            status: {
                $in: [
                    ASSIGNMENT_STATUSES.PENDING,
                    ASSIGNMENT_STATUSES.ACCEPTED
                ]
            }
        }
    }
);

assignmentSchema.index({
    specialistUserId: 1,
    status: 1
});

assignmentSchema.index({
    advisorId: 1,
    status: 1
});

export default mongoose.model(
    "AdvisorSpecialistAssignment",
    assignmentSchema
);