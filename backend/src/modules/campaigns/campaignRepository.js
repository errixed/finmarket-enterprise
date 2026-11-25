import Campaign from "./models/Campaign.js";
import Template from "./models/Template.js";
import { findMarketingEligibleLeads } from "../leads/leadService.js";
import { Types } from "mongoose";

const campaigns = new Map();
const templates = new Map();

const copy = (value) => structuredClone(value);

function validateModel(Model, data) {
    const document = new Model(data);
    const error = document.validateSync();

    if (error) {
        error.statusCode = 400;
        throw error;
    }

    return document.toObject({
        flattenObjectIds: true
    });
}

export function createTemplate(data) {
    const template = validateModel(Template, {
        ...data,
        _id: new Types.ObjectId(),
        createdAt: new Date(),
        updatedAt: new Date()
    });

    templates.set(String(template._id), copy(template));

    return copy(template);
}

export async function createCampaign(data) {
    const campaign = validateModel(Campaign, {
        ...data,
        _id: new Types.ObjectId(),
        createdAt: new Date(),
        updatedAt: new Date()
    });

    campaigns.set(String(campaign._id), copy(campaign));

    return copy(campaign);
}

export function listCampaigns({ advisorId, status }) {
    return [...campaigns.values()]
        .filter(campaign =>
            String(campaign.advisorId) === String(advisorId) &&
            (!status || campaign.status === status)
        )
        .sort((a, b) =>
            new Date(b.updatedAt) - new Date(a.updatedAt)
        )
        .map(copy);
}

export function findCampaign({ advisorId, campaignId }) {
    const campaign = campaigns.get(String(campaignId));

    if (!campaign || String(campaign.advisorId) !== String(advisorId)) {
        return null;
    }

    return copy(campaign);
}

export async function updateCampaign({ advisorId, campaignId, changes }) {
    const existing = findCampaign({ advisorId, campaignId });

    if (!existing) {
        return null;
    }

    const updated = validateModel(Campaign, {
        ...existing,
        ...changes,
        _id: existing._id,
        advisorId: existing.advisorId,
        createdAt: existing.createdAt,
        updatedAt: new Date()
    });

    campaigns.set(String(campaignId), copy(updated));

    return copy(updated);
}

export function listTemplates({ advisorId, channel }) {
    return [...templates.values()]
        .filter(template =>
            String(template.advisorId) === String(advisorId) &&
            template.isActive === true &&
            (!channel || template.channel === channel)
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(copy);
}

export function findTemplate({ advisorId, templateId }) {
    const template = templates.get(String(templateId));

    if (
        !template ||
        String(template.advisorId) !== String(advisorId) ||
        template.isActive !== true
    ) {
        return null;
    }

    return copy(template);
}

export async function findAudience({ advisorId, interests, leadStatuses }) {
    const filters = {};
    if (interests.length > 0) {
        filters.interest = {
            $in: interests.map(interest => new RegExp(
                `^${interest.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                "i"
            ))
        };
    }
    if (leadStatuses.length > 0) {
        filters.status = { $in: leadStatuses };
    }

    const leads = await findMarketingEligibleLeads(advisorId, filters);
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
