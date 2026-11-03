import mongoose from "mongoose";

const advisorSpecialistAssignmentSchema =
    new mongoose.Schema(
        {
            advisorId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "AdvisorProfile",
                required: true
            },

            specialistUserId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                required: true
            },

            status: {
                type: String,
                enum: [
                    "PENDING",
                    "ACCEPTED",
                    "DECLINED",
                    "REVOKED"
                ],
                default: "PENDING",
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
            collection: "advisorSpecialistAssignments"
        }
    );

advisorSpecialistAssignmentSchema.index(
    {
        advisorId: 1,
        specialistUserId: 1
    },
    {
        unique: true,
        partialFilterExpression: {
            status: {
                $in: ["PENDING", "ACCEPTED"]
            }
        }
    }
);

advisorSpecialistAssignmentSchema.index({
    specialistUserId: 1,
    status: 1
});

advisorSpecialistAssignmentSchema.index({
    advisorId: 1,
    status: 1
});

export default mongoose.model(
    "AdvisorSpecialistAssignment",
    advisorSpecialistAssignmentSchema
);