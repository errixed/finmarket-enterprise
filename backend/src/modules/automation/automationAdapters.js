import mongoose from "mongoose";
import User from "../identity/models/User.js";
import AdvisorProfile from "../identity/models/AdvisorProfile.js";
import AdvisorSpecialistAssignment from "../identity/models/AdvisorSpecialistAssignment.js";
import Campaign from "../campaigns/models/Campaign.js";
import Lead from "../leads/models/Lead.js";
import DeliveryJob from "../delivery/models/DeliveryJob.js";

// Adapter interfaces between Automation and the other modules.
//
// The Automation module never reaches into another module's business logic.
// It talks to them through these small interfaces, and every one can be
// replaced with a mock (see tests/automation/helpers). The default
// implementations below only READ shared collections, except the delivery
// adapter, which calls Delivery's own queueing service.
//
//   identity   { findUser, getAdvisorIdForUser, hasAcceptedAssignment,
//                listAcceptedAdvisorIds }
//   campaigns  { findCampaign, listSpecialistCampaignIds }
//   leads      { findLead }
//   deliveries { findDeliveryJob }
//   delivery   { requestDelivery }
//   metrics    { leadMetrics, campaignMetrics, deliveryMetrics }
//
// advisorId always means AdvisorProfile._id. ownerId always means User._id.

const toId = (value) => (value === null || value === undefined ? null : String(value));

const objectId = (value) => new mongoose.Types.ObjectId(String(value));

// ---------------------------------------------------------------------------
// Identity (Member 1)
// ---------------------------------------------------------------------------

export function createIdentityAdapter() {
    const adapter = {
        // -> { id, role, isActive } | null
        async findUser(userId) {
            const user = await User.findById(userId).select("role isActive").lean();

            return user
                ? { id: toId(user._id), role: user.role, isActive: user.isActive !== false }
                : null;
        },

        // AdvisorProfile._id of an active ADVISOR user, or null.
        async getAdvisorIdForUser(userId) {
            const user = await adapter.findUser(userId);

            if (!user || !user.isActive || user.role !== "ADVISOR") return null;

            const profile = await AdvisorProfile.findOne({ userId }).select("_id").lean();

            return profile ? toId(profile._id) : null;
        },

        // User._id of the advisor who owns an AdvisorProfile, or null.
        async getUserIdForAdvisor(advisorId) {
            const profile = await AdvisorProfile.findById(advisorId).select("userId").lean();

            return profile ? toId(profile.userId) : null;
        },

        // Accepted advisor-specialist relationship (status ACCEPTED only,
        // so PENDING, DECLINED and REVOKED never grant access).
        async hasAcceptedAssignment(advisorId, specialistUserId) {
            const specialist = await adapter.findUser(specialistUserId);

            if (
                !specialist ||
                !specialist.isActive ||
                specialist.role !== "MARKETING_SPECIALIST"
            ) {
                return false;
            }

            const profile = await AdvisorProfile.findById(advisorId).select("userId").lean();
            const advisorUser = profile ? await adapter.findUser(profile.userId) : null;

            if (!advisorUser || !advisorUser.isActive || advisorUser.role !== "ADVISOR") {
                return false;
            }

            const assignment = await AdvisorSpecialistAssignment.exists({
                advisorId,
                specialistUserId,
                status: "ACCEPTED"
            });

            return Boolean(assignment);
        },

        // AdvisorProfile ids that currently have an accepted relationship
        // with this specialist.
        async listAcceptedAdvisorIds(specialistUserId) {
            const specialist = await adapter.findUser(specialistUserId);

            if (
                !specialist ||
                !specialist.isActive ||
                specialist.role !== "MARKETING_SPECIALIST"
            ) {
                return [];
            }

            const assignments = await AdvisorSpecialistAssignment.find({
                specialistUserId,
                status: "ACCEPTED"
            })
                .select("advisorId")
                .lean();

            const accepted = [];

            for (const { advisorId } of assignments) {
                if (await adapter.hasAcceptedAssignment(advisorId, specialistUserId)) {
                    accepted.push(toId(advisorId));
                }
            }

            return accepted;
        }
    };

    return adapter;
}

// ---------------------------------------------------------------------------
// Campaigns (Member 3)
// ---------------------------------------------------------------------------

export function createCampaignAdapter() {
    return {
        // -> { id, advisorId, status, channel, assignedSpecialistIds } | null
        async findCampaign(campaignId) {
            const campaign = await Campaign.findById(campaignId)
                .select("advisorId status channel assignedSpecialistIds")
                .setOptions({ strictQuery: false })
                .lean();

            return campaign
                ? {
                    id: toId(campaign._id),
                    advisorId: toId(campaign.advisorId),
                    status: campaign.status,
                    channel: campaign.channel,
                    assignedSpecialistIds: (campaign.assignedSpecialistIds ?? []).map(toId)
                }
                : null;
        },

        // Campaign ids this specialist is explicitly assigned to, limited to
        // advisors with an accepted relationship (checked by the caller).
        async listSpecialistCampaignIds(specialistUserId, advisorIds) {
            if (advisorIds.length === 0) return [];

            const campaigns = await Campaign.find({
                advisorId: { $in: advisorIds.map(objectId) },
                assignedSpecialistIds: objectId(specialistUserId)
            })
                .select("_id")
                .setOptions({ strictQuery: false })
                .lean();

            return campaigns.map((campaign) => toId(campaign._id));
        }
    };
}

// ---------------------------------------------------------------------------
// Leads (Member 2) and delivery jobs (Member 4): entity lookups
// ---------------------------------------------------------------------------

export function createLeadAdapter() {
    return {
        // -> { id, advisorId, status } | null
        async findLead(leadId) {
            const document = await Lead.findById(leadId).select("advisorId status").lean();

            if (document) {
                return {
                    id: toId(document._id),
                    advisorId: toId(document.advisorId),
                    status: document.status
                };
            }

            // Phase I leads still live in the Leads module's own store on
            // some branches. Read through the Leads repository, never write.
            try {
                const { default: leadRepository } = await import("../leads/leadRepository.js");
                const lead = await leadRepository.findById(String(leadId));

                return lead
                    ? {
                        id: toId(lead._id ?? lead.id),
                        advisorId: toId(lead.advisorId),
                        status: lead.status
                    }
                    : null;
            } catch {
                return null;
            }
        }
    };
}

export function createDeliveryLookupAdapter() {
    return {
        // -> { id, advisorId, campaignId } | null
        async findDeliveryJob(deliveryJobId) {
            const job = await DeliveryJob.findById(deliveryJobId)
                .select("advisorId campaignId")
                .lean();

            return job
                ? {
                    id: toId(job._id),
                    advisorId: toId(job.advisorId),
                    campaignId: toId(job.campaignId)
                }
                : null;
        }
    };
}

// ---------------------------------------------------------------------------
// Delivery requests (Member 4)
// ---------------------------------------------------------------------------

// Fields Delivery's queueing service accepts today. When Member 4 adds
// idempotencyKey to the contract, add it here and nothing else changes.
const DELIVERY_ACCEPTED_FIELDS = [
    "advisorId",
    "campaignId",
    "leadId",
    "channel",
    "content",
    "scheduledAt"
];

export function createDeliveryAdapter() {
    return {
        // request: {
        //   idempotencyKey, advisorId, campaignId, leadId, channel,
        //   content: { subject, body }, scheduledAt,
        //   source: "AUTOMATION", automationRuleId, eventId
        // }
        // -> { deliveryJobId, status }
        // Throws an error with statusCode when Delivery rejects the request:
        //   4xx  definite rejection (consent, campaign state, validation)
        //   503  provider/service unavailable, safe to retry
        // Anything else is treated as an unknown outcome and not retried.
        async requestDelivery(request) {
            const { queueDelivery } = await import("../delivery/services/deliveryService.js");

            const payload = Object.fromEntries(
                DELIVERY_ACCEPTED_FIELDS
                    .filter((field) => request[field] !== undefined && request[field] !== null)
                    .map((field) => [field, request[field]])
            );

            const job = await queueDelivery(payload);

            return {
                deliveryJobId: toId(job._id ?? job.id),
                status: job.deliveryStatus ?? "PENDING"
            };
        }
    };
}

// ---------------------------------------------------------------------------
// Business metrics for analytics (Leads, Campaigns, Delivery data)
// ---------------------------------------------------------------------------

async function countByStatus(model, match, field = "status") {
    const rows = await model.aggregate([
        { $match: match },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } }
    ]);

    return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

export function createMetricsAdapter() {
    return {
        // scope: { advisorId } for one advisor, {} for the whole platform.
        async leadMetrics({ advisorId } = {}) {
            const match = advisorId ? { advisorId: objectId(advisorId) } : {};

            return countByStatus(Lead, match);
        },

        // scope: { advisorId } | { campaignIds } | {} (platform)
        async campaignMetrics({ advisorId, campaignIds } = {}) {
            const match = campaignIds
                ? { _id: { $in: campaignIds.map(objectId) } }
                : advisorId
                    ? { advisorId: objectId(advisorId) }
                    : {};

            return countByStatus(Campaign, match);
        },

        async deliveryMetrics({ advisorId, campaignIds } = {}) {
            const match = campaignIds
                ? { campaignId: { $in: campaignIds.map(objectId) } }
                : advisorId
                    ? { advisorId: objectId(advisorId) }
                    : {};

            return countByStatus(DeliveryJob, match, "deliveryStatus");
        }
    };
}

export function createDefaultAdapters() {
    return {
        identity: createIdentityAdapter(),
        campaigns: createCampaignAdapter(),
        leads: createLeadAdapter(),
        deliveries: createDeliveryLookupAdapter(),
        delivery: createDeliveryAdapter(),
        metrics: createMetricsAdapter()
    };
}
