import User from "./models/User.js";
import AdvisorSpecialistAssignment
    from "./models/AdvisorSpecialistAssignment.js";

export const adminRepository = {
    async listUsers() {
        return User.find()
            .sort({ createdAt: -1 })
            .lean();
    },

    async findUserById(id) {
        return User.findById(id).lean();
    },

    async updateUserStatus(id, isActive) {
        const update = {
            $set: {
                isActive
            }
        };

        if (isActive === false) {
            update.$inc = {
                tokenVersion: 1
            };
        }

        return User.findByIdAndUpdate(
            id,
            update,
            {
                returnDocument: "after",
                runValidators: true
            }
        ).lean();
    },

    async listAssignments() {
        return AdvisorSpecialistAssignment.find()
            .sort({ createdAt: -1 })
            .populate({
                path: "advisorId",
                select: "userId",
                populate: {
                    path: "userId",
                    select: "name email"
                }
            })
            .populate(
                "specialistUserId",
                "name email role"
            );
    },

    async revokeAssignment(id) {
        return AdvisorSpecialistAssignment.findOneAndUpdate(
            {
                _id: id,
                status: "ACCEPTED"
            },
            {
                $set: {
                    status: "REVOKED",
                    revokedAt: new Date()
                }
            },
            {
                returnDocument: "after",
                runValidators: true
            }
        );
    }
};