import mongoose from "mongoose";
import Lead from "../../leads/models/Lead.js";
import Campaign from "../../campaigns/models/Campaign.js";
import User from "../../identity/models/User.js";
import AdvisorProfile from "../../identity/models/AdvisorProfile.js";
import AdvisorSpecialistAssignment from "../../identity/models/AdvisorSpecialistAssignment.js";
import leadRepository from "../../leads/leadRepository.js";
import campaignService from "../../campaigns/campaignService.js";

const { Types } = mongoose;

const isDbConnected = () => mongoose.connection.readyState === 1;

const normalizeId = (value) => (value ? String(value) : null);

const defaultEventListeners = new Set();

export const defaultDeliveryContracts = {
    async findLeadById(leadId) {
        if (!leadId) return null;

        if (isDbConnected() && Types.ObjectId.isValid(leadId)) {
            const dbLead = await Lead.findById(leadId).lean();
            if (dbLead) return dbLead;
        }

        const fallbackLead = await Promise.resolve(
            leadRepository.findById(String(leadId))
        );
        return fallbackLead ?? null;
    },

    async findCampaignById(campaignId, fallbackAdvisorId = null) {
        if (!campaignId) return null;

        if (isDbConnected() && Types.ObjectId.isValid(campaignId)) {
            const dbCampaign = await Campaign.findById(campaignId).lean();
            if (dbCampaign) return dbCampaign;
        }

        if (fallbackAdvisorId) {
            try {
                return await campaignService.getCampaign({
                    advisorId: String(fallbackAdvisorId),
                    campaignId: String(campaignId)
                });
            } catch {
                return null;
            }
        }

        return null;
    },

    async hasAcceptedAssignment(advisorId, specialistUserId) {
        if (
            !isDbConnected() ||
            !Types.ObjectId.isValid(advisorId) ||
            !Types.ObjectId.isValid(specialistUserId)
        ) {
            return false;
        }

        const [advisorProfile, specialistUser] = await Promise.all([
            AdvisorProfile.findById(advisorId).lean(),
            User.findById(specialistUserId).lean()
        ]);

        if (!advisorProfile || !specialistUser) {
            return false;
        }

        if (
            !specialistUser.isActive ||
            specialistUser.role !== "MARKETING_SPECIALIST"
        ) {
            return false;
        }

        const advisorUser = await User.findById(advisorProfile.userId).lean();
        if (!advisorUser || !advisorUser.isActive || advisorUser.role !== "ADVISOR") {
            return false;
        }

        const assignment = await AdvisorSpecialistAssignment.findOne({
            advisorId: new Types.ObjectId(String(advisorId)),
            specialistUserId: new Types.ObjectId(String(specialistUserId)),
            status: "ACCEPTED"
        }).lean();

        return Boolean(assignment);
    },

    async isSpecialistAssignedToCampaign(campaign, specialistUserId) {
        if (!campaign || !specialistUserId) return false;

        const assigned = Array.isArray(campaign.assignedSpecialistIds)
            ? campaign.assignedSpecialistIds
            : [];

        return assigned.some((id) => normalizeId(id) === String(specialistUserId));
    },

    async listAuthorizedCampaignIdsForSpecialist(specialistUserId) {
        if (!isDbConnected() || !Types.ObjectId.isValid(specialistUserId)) {
            return [];
        }

        const specialistObjectId = new Types.ObjectId(String(specialistUserId));

        const acceptedAssignments = await AdvisorSpecialistAssignment.find({
            specialistUserId: specialistObjectId,
            status: "ACCEPTED"
        }).lean();

        if (acceptedAssignments.length === 0) {
            return [];
        }

        const acceptedAdvisorIds = acceptedAssignments.map((a) => a.advisorId);

        const campaigns = await mongoose.connection
            .collection("campaigns")
            .find({
                advisorId: { $in: acceptedAdvisorIds },
                assignedSpecialistIds: {
                    $in: [specialistObjectId, String(specialistUserId)]
                }
            })
            .project({ _id: 1 })
            .toArray();

        return campaigns.map((c) => String(c._id));
    },

    async isLeadInCampaignAudience(campaign, lead) {
        if (!campaign || !lead) return false;

        if (normalizeId(lead.advisorId) !== normalizeId(campaign.advisorId)) {
            return false;
        }

        if (Array.isArray(campaign.eligibleLeadIds)) {
            return campaign.eligibleLeadIds.some(
                (id) => normalizeId(id) === normalizeId(lead._id)
            );
        }

        if (campaign.audience && typeof campaign.audience === "object") {
            const interests = Array.isArray(campaign.audience.interests)
                ? campaign.audience.interests
                : [];
            const leadStatuses = Array.isArray(campaign.audience.leadStatuses)
                ? campaign.audience.leadStatuses
                : [];

            const interestMatches =
                interests.length === 0 ||
                interests.some(
                    (item) =>
                        String(item).trim().toLowerCase() ===
                        String(lead.interest ?? "").trim().toLowerCase()
                );

            const statusMatches =
                leadStatuses.length === 0 ||
                leadStatuses.includes(lead.status);

            return interestMatches && statusMatches;
        }

        try {
            const audience = await campaignService.getAudience({
                advisorId: String(campaign.advisorId),
                campaignId: String(campaign._id)
            });

            return audience.recipients.some(
                (recipient) => normalizeId(recipient._id) === normalizeId(lead._id)
            );
        } catch {
            return false;
        }
    },

    async emitDeliveryEvent(eventType, deliveryJob, extra = {}) {
        const event = {
            eventId: `evt-${new Types.ObjectId().toString()}`,
            eventType,
            entityId: String(deliveryJob._id),
            entityType: "DELIVERY_JOB",
            ownerId: deliveryJob.createdByUserId
                ? String(deliveryJob.createdByUserId)
                : String(deliveryJob.advisorId),
            metadata: {
                deliveryJobId: String(deliveryJob._id),
                advisorId: String(deliveryJob.advisorId),
                campaignId: String(deliveryJob.campaignId),
                leadId: deliveryJob.leadId ? String(deliveryJob.leadId) : null,
                channel: deliveryJob.channel,
                deliveryStatus: deliveryJob.deliveryStatus,
                provider: deliveryJob.provider ?? null,
                simulated: Boolean(deliveryJob.simulated),
                ...extra
            },
            occurredAt: new Date().toISOString()
        };

        for (const listener of defaultEventListeners) {
            try {
                await listener(event);
            } catch {
                // Automation listeners must not break delivery processing.
            }
        }

        return event;
    }
};

let activeContracts = { ...defaultDeliveryContracts };

export const getDeliveryContracts = () => activeContracts;

export const setDeliveryContracts = (overrides = {}) => {
    activeContracts = {
        ...defaultDeliveryContracts,
        ...overrides
    };
    return activeContracts;
};

export const resetDeliveryContracts = () => {
    activeContracts = { ...defaultDeliveryContracts };
    return activeContracts;
};

export const registerDeliveryEventListener = (listener) => {
    if (typeof listener === "function") {
        defaultEventListeners.add(listener);
    }
    return () => defaultEventListeners.delete(listener);
};