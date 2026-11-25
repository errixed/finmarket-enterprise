import Campaign from "./models/Campaign.js";
import Template from "./models/Template.js";
import AdvisorProfile from "../identity/models/AdvisorProfile.js";
import User from "../identity/models/User.js";
import Assignment from "../identity/models/AdvisorSpecialistAssignment.js";
import { findMarketingEligibleLeads } from "../leads/leadService.js";

const plain = (document) =>
    document?.toObject({ flattenObjectIds: true }) ?? null;

const escapeRegex = (value) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const findAdvisor = (advisorId) =>
    AdvisorProfile.findById(advisorId).lean();

export const findAdvisorByUser = (userId) =>
    AdvisorProfile.findOne({ userId }).lean();

export const findUser = (userId) =>
    User.findOne({
        _id: userId,
        isActive: true
    }).select("_id name role").lean();

export const acceptedAdvisorIds = async (specialistUserId) => {
    const ids = await Assignment.distinct("advisorId", {
        specialistUserId,
        status: "ACCEPTED",
        revokedAt: null
    });

    return AdvisorProfile.distinct("_id", {
        _id: { $in: ids }
    });
};

export const hasAcceptedRelationship = async (
    advisorId,
    specialistUserId
) => Boolean(
    await Assignment.exists({
        advisorId,
        specialistUserId,
        status: "ACCEPTED",
        revokedAt: null
    })
);

export async function createTemplate(data) {
    return plain(await Template.create(data));
}

export async function createCampaign(data) {
    return plain(await Campaign.create(data));
}

export function listCampaigns({
    advisorId,
    status,
    specialistUserId,
    advisorIds
}) {
    const filter = {
        ...(advisorId
            ? { advisorId }
            : { advisorId: { $in: advisorIds ?? [] } }),
        ...(status ? { status } : {}),
        ...(specialistUserId
            ? { assignedSpecialistIds: specialistUserId }
            : {})
    };

    return Campaign.find(filter)
        .sort({ updatedAt: -1 })
        .lean();
}

export function findCampaign({ advisorId, campaignId }) {
    return Campaign.findOne({
        _id: campaignId,
        ...(advisorId ? { advisorId } : {})
    }).lean();
}

export async function updateCampaign({
    advisorId,
    campaignId,
    changes,
    version,
    specialistUserId
}) {
    return Campaign.findOneAndUpdate(
        {
            _id: campaignId,
            advisorId,
            __v: version,
            ...(specialistUserId
                ? { assignedSpecialistIds: specialistUserId }
                : {})
        },
        {
            $set: changes,
            $inc: { __v: 1 }
        },
        {
            returnDocument: "after",
            runValidators: true
        }
    ).lean();
}

export function listTemplates({
    advisorId,
    channel,
    templateIds
}) {
    return Template.find({
        ...(advisorId ? { advisorId } : {}),
        ...(templateIds
            ? { _id: { $in: templateIds } }
            : {}),
        isActive: true,
        ...(channel ? { channel } : {})
    })
        .sort({ name: 1 })
        .lean();
}

export function findTemplate({ advisorId, templateId }) {
    return Template.findOne({
        _id: templateId,
        ...(advisorId ? { advisorId } : {}),
        isActive: true
    }).lean();
}

export function changeAssignment({
    advisorId,
    campaignId,
    userId,
    add
}) {
    return Campaign.findOneAndUpdate(
        {
            _id: campaignId,
            advisorId,
            assignedSpecialistIds: add
                ? { $ne: userId }
                : userId
        },
        {
            [add ? "$addToSet" : "$pull"]: {
                assignedSpecialistIds: userId
            },
            $inc: { __v: 1 }
        },
        {
            returnDocument: "after",
            runValidators: true
        }
    ).lean();
}

export async function findAudience({
    advisorId,
    interests = [],
    leadStatuses = []
}) {
    const filters = {};

    if (interests.length > 0) {
        filters.interest = {
            $in: interests.map(
                interest => new RegExp(
                    `^${escapeRegex(interest.trim())}$`,
                    "i"
                )
            )
        };
    }

    if (leadStatuses.length > 0) {
        filters.status = {
            $in: leadStatuses
        };
    }

    const leads = await findMarketingEligibleLeads(
        advisorId,
        filters
    );

    return leads
        .map(lead => ({
            _id: lead._id,
            name: lead.name,
            email: lead.email,
            interest: lead.interest,
            status: lead.status
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}