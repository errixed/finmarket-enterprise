import mongoose from "mongoose";
import DeliveryJob, { DELIVERY_CHANNELS } from "../models/DeliveryJob.js";
import AppError from "../../../utils/AppError.js";

const { Types } = mongoose;

const ALLOWED_QUEUE_FIELDS = new Set([
    "advisorId",
    "campaignId",
    "leadId",
    "channel",
    "recipientEmail",
    "content",
    "scheduledAt",
    "idempotencyKey"
]);

export const DELIVERY_EVENTS = Object.freeze({
    QUEUED: "DELIVERY_QUEUED",
    SENT: "DELIVERY_SENT",
    FAILED: "DELIVERY_FAILED"
});

export const assertValidObjectId = (value, fieldName) => {
    if (!value || !Types.ObjectId.isValid(value)) {
        throw new AppError(
            `Invalid ${fieldName}.`,
            400,
            "INVALID_OBJECT_ID"
        );
    }
    return String(value);
};

export const validateQueuePayload = (data) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new AppError(
            "Request body must be a JSON object.",
            400,
            "INVALID_REQUEST"
        );
    }

    const unknownFields = Object.keys(data).filter(
        (field) => !ALLOWED_QUEUE_FIELDS.has(field)
    );

    if (unknownFields.length > 0) {
        throw new AppError(
            `Unsupported field(s): ${unknownFields.join(", ")}.`,
            400,
            "INVALID_REQUEST"
        );
    }

    assertValidObjectId(data.campaignId, "campaignId");

    if (data.leadId !== undefined && data.leadId !== null) {
        assertValidObjectId(data.leadId, "leadId");
    }

    if (!DELIVERY_CHANNELS.includes(data.channel)) {
        throw new AppError(
            "Unsupported delivery channel.",
            400,
            "INVALID_CHANNEL"
        );
    }

    if (
        !data.content ||
        typeof data.content !== "object" ||
        Array.isArray(data.content)
    ) {
        throw new AppError(
            "content must be an object.",
            400,
            "INVALID_REQUEST"
        );
    }

    if (
        typeof data.content.body !== "string" ||
        data.content.body.trim().length === 0
    ) {
        throw new AppError(
            "content.body is required.",
            400,
            "INVALID_CONTENT"
        );
    }

    if (data.scheduledAt !== undefined && data.scheduledAt !== null) {
        const parsedDate = new Date(data.scheduledAt);
        if (Number.isNaN(parsedDate.getTime())) {
            throw new AppError(
                "scheduledAt must be a valid ISO date.",
                400,
                "INVALID_SCHEDULED_AT"
            );
        }
    }
};

export const authorizeCampaignAccess = async (auth, campaign, contracts) => {
    if (!auth || !auth.userId || !auth.role) {
        throw new AppError(
            "Authentication required.",
            401,
            "UNAUTHORIZED"
        );
    }

    if (!campaign) {
        throw new AppError(
            "Campaign not found.",
            404,
            "CAMPAIGN_NOT_FOUND"
        );
    }

    const campaignAdvisorId = String(campaign.advisorId);

    if (auth.role === "ADVISOR") {
        if (!auth.advisorId || String(auth.advisorId) !== campaignAdvisorId) {
            throw new AppError(
                "You do not have permission to access another advisor's campaign.",
                403,
                "FORBIDDEN"
            );
        }
        return true;
    }

    if (auth.role === "MARKETING_SPECIALIST") {
        const hasRelationship = await contracts.hasAcceptedAssignment(
            campaignAdvisorId,
            auth.userId
        );

        if (!hasRelationship) {
            throw new AppError(
                "An accepted advisor-specialist relationship is required.",
                403,
                "ASSIGNMENT_REQUIRED"
            );
        }

        const isAssigned = await contracts.isSpecialistAssignedToCampaign(
            campaign,
            auth.userId
        );

        if (!isAssigned) {
            throw new AppError(
                "You are not assigned to this campaign.",
                403,
                "CAMPAIGN_ASSIGNMENT_REQUIRED"
            );
        }

        return true;
    }

    throw new AppError(
        "Your role is not authorized to perform this delivery operation.",
        403,
        "FORBIDDEN"
    );
};

export const validateCampaignEligibility = (campaign, channel) => {
    if (!campaign) {
        throw new AppError(
            "Campaign not found.",
            404,
            "CAMPAIGN_NOT_FOUND"
        );
    }

    if (campaign.status !== "ACTIVE") {
        throw new AppError(
            "Only ACTIVE campaigns can queue or process deliveries.",
            400,
            "CAMPAIGN_NOT_ACTIVE"
        );
    }

    if (campaign.channel !== channel) {
        throw new AppError(
            "Delivery channel must match the campaign channel.",
            400,
            "CHANNEL_MISMATCH"
        );
    }
};

export const validateRecipientConsentAndEligibility = async ({
    channel,
    leadId,
    recipientEmail,
    campaign,
    contracts
}) => {
    if (channel !== "EMAIL") {
        return { lead: null, recipientEmail: null };
    }

    if (!leadId) {
        throw new AppError(
            "leadId is required for email delivery.",
            400,
            "LEAD_ID_REQUIRED"
        );
    }

    // 1. Referenced Lead exists
    const lead = await contracts.findLeadById(leadId);
    if (!lead) {
        throw new AppError(
            "Lead not found.",
            404,
            "LEAD_NOT_FOUND"
        );
    }

    // 2. Lead belongs to the Campaign's Advisor
    if (String(lead.advisorId) !== String(campaign.advisorId)) {
        throw new AppError(
            "Lead does not belong to the campaign's advisor.",
            403,
            "LEAD_ADVISOR_MISMATCH"
        );
    }

    // 3 & 4. Explicit marketing consent and not unsubscribed
    if (lead.marketingConsent !== true || lead.unsubscribedAt != null) {
        throw new AppError(
            "The lead has not consented to marketing or has unsubscribed.",
            403,
            "MARKETING_CONSENT_REQUIRED"
        );
    }

    // 5. Recipient email matches Lead's registered email
    const leadEmail = String(lead.email ?? "").trim().toLowerCase();
    if (!leadEmail) {
        throw new AppError(
            "Lead does not have a valid email address.",
            400,
            "INVALID_RECIPIENT_EMAIL"
        );
    }

    if (
        recipientEmail &&
        String(recipientEmail).trim().toLowerCase() !== leadEmail
    ) {
        throw new AppError(
            "recipientEmail does not match the selected lead.",
            400,
            "RECIPIENT_MISMATCH"
        );
    }

    // 6. Lead belongs to the Campaign's eligible audience
    const inAudience = await contracts.isLeadInCampaignAudience(campaign, lead);
    if (!inAudience) {
        throw new AppError(
            "Lead does not belong to the selected campaign audience.",
            403,
            "LEAD_NOT_IN_AUDIENCE"
        );
    }

    return { lead, recipientEmail: leadEmail };
};

export const validateDeliveryModelDocument = async (data) => {
    const job = new DeliveryJob(data);

    try {
        await job.validate();
    } catch (error) {
        error.statusCode = 400;
        throw error;
    }

    return job.toObject({ flattenObjectIds: true });
};