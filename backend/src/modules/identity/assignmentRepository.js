import AdvisorSpecialistAssignment from "./models/AdvisorSpecialistAssignment.js";
import { ASSIGNMENT_STATUSES as STATUS } from "./identityConstants.js";

export const assignmentRepository = {
    async findById(id) {
        return AdvisorSpecialistAssignment.findById(id);
    },

    async findActivePair(advisorId, specialistUserId) {
        return AdvisorSpecialistAssignment.findOne({
            advisorId,
            specialistUserId,
            status: {
                $in: [
                    STATUS.PENDING,
                    STATUS.ACCEPTED
                ]
            }
        });
    },

    async create(data) {
        return AdvisorSpecialistAssignment.create(data);
    },

    async listForAdvisor(advisorId, status = null) {
        const filter = { advisorId };

        if (status) filter.status = status;

        return AdvisorSpecialistAssignment.find(filter)
            .sort({ createdAt: -1 })
            .populate(
                "specialistUserId",
                "name email role"
            )
            .exec();
    },

    async listForSpecialist(specialistUserId, status = null) {
        const filter = { specialistUserId };

        if (status) filter.status = status;

        return AdvisorSpecialistAssignment.find(filter)
            .sort({ createdAt: -1 })
            .populate({
                path: "advisorId",
                select: "userId",
                populate: {
                    path: "userId",
                    select: "name"
                }
            })
            .exec();
    },

    async accept(id, specialistUserId) {
        return AdvisorSpecialistAssignment.findOneAndUpdate(
            {
                _id: id,
                specialistUserId,
                status: STATUS.PENDING
            },
            {
                $set: {
                    status: STATUS.ACCEPTED,
                    acceptedAt: new Date()
                }
            },
            {
                returnDocument: "after",
                runValidators: true
            }
        );
    },

    async decline(id, specialistUserId) {
        return AdvisorSpecialistAssignment.findOneAndUpdate(
            {
                _id: id,
                specialistUserId,
                status: STATUS.PENDING
            },
            {
                $set: {
                    status: STATUS.DECLINED
                }
            },
            {
                returnDocument: "after",
                runValidators: true
            }
        );
    },

    async revoke(id, advisorId) {
        return AdvisorSpecialistAssignment.findOneAndUpdate(
            {
                _id: id,
                advisorId,
                status: STATUS.ACCEPTED
            },
            {
                $set: {
                    status: STATUS.REVOKED,
                    revokedAt: new Date()
                }
            },
            {
                returnDocument: "after",
                runValidators: true
            }
        );
    },

    async hasAcceptedRelationship(advisorId, specialistUserId) {
        const record = await AdvisorSpecialistAssignment.exists({
            advisorId,
            specialistUserId,
            status: STATUS.ACCEPTED
        });

        return Boolean(record);
    }
};