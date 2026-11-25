import * as deliveryRepo from "../repositories/deliveryRepository.js";
import { getDeliveryContracts } from "../contracts/deliveryContracts.js";
import {
    DELIVERY_EVENTS,
    assertValidObjectId,
    validateQueuePayload,
    authorizeCampaignAccess,
    validateCampaignEligibility,
    validateRecipientConsentAndEligibility,
    validateDeliveryModelDocument
} from "./deliveryEligibility.js";
import {
    resolveProviderName,
    dispatchToProvider
} from "../providers/providerRegistry.js";
import { deliveryRateLimiter } from "../providers/deliveryRateLimiter.js";
import AppError from "../../../utils/AppError.js";

const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

const parseOptionalDate = (value, fieldName) => {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new AppError(
            `Invalid date value for ${fieldName}.`,
            400,
            "INVALID_DATE_FILTER"
        );
    }

    return parsed;
};

const requireAuthContext = (auth) => {
    if (!auth || !auth.userId || !auth.role) {
        throw new AppError(
            "Authentication required.",
            401,
            "UNAUTHORIZED"
        );
    }
};

const buildValidatedJobPayload = async ({
    deliveryData,
    campaign,
    createdByUserId,
    contracts,
    env
}) => {
    validateCampaignEligibility(campaign, deliveryData.channel);

    const { recipientEmail } = await validateRecipientConsentAndEligibility({
        channel: deliveryData.channel,
        leadId: deliveryData.leadId ?? null,
        recipientEmail: deliveryData.recipientEmail ?? null,
        campaign,
        contracts
    });

    const providerName = resolveProviderName(deliveryData.channel, env);

    const payload = {
        advisorId: String(campaign.advisorId),
        campaignId: String(campaign._id),
        leadId: deliveryData.channel === "EMAIL" ? String(deliveryData.leadId) : null,
        createdByUserId: createdByUserId ? String(createdByUserId) : null,
        channel: deliveryData.channel,
        recipientEmail,
        content: {
            subject: deliveryData.content?.subject ?? "",
            body: deliveryData.content.body.trim()
        },
        scheduledAt: deliveryData.scheduledAt
            ? new Date(deliveryData.scheduledAt)
            : null,
        idempotencyKey: deliveryData.idempotencyKey ?? null,
        provider: providerName,
        simulated: providerName ? providerName.startsWith("MOCK_") : true
    };

    await validateDeliveryModelDocument(payload);

    return payload;
};

const executeDeliveryJob = async (job, options = {}) => {
    const contracts = options.contracts ?? getDeliveryContracts();
    const rateLimiter = options.rateLimiter ?? deliveryRateLimiter;
    const now = options.now ? new Date(options.now) : new Date();

    if (job.deliveryStatus !== "PENDING") {
        throw new AppError(
            "Only PENDING delivery jobs can be processed.",
            409,
            "INVALID_DELIVERY_STATUS"
        );
    }

    if (job.scheduledAt && new Date(job.scheduledAt) > now) {
        throw new AppError(
            "Delivery job is scheduled for a future date.",
            409,
            "DELIVERY_NOT_DUE"
        );
    }

    const campaign =
        options.preloadedCampaign ??
        (await contracts.findCampaignById(job.campaignId, job.advisorId));

    if (!campaign) {
        throw new AppError(
            "Campaign not found.",
            404,
            "CAMPAIGN_NOT_FOUND"
        );
    }

    if (String(campaign.advisorId) !== String(job.advisorId)) {
        throw new AppError(
            "Delivery job ownership does not match the campaign.",
            403,
            "ADVISOR_MISMATCH"
        );
    }

    validateCampaignEligibility(campaign, job.channel);

    await validateRecipientConsentAndEligibility({
        channel: job.channel,
        leadId: job.leadId,
        recipientEmail: job.recipientEmail,
        campaign,
        contracts
    });

    const providerName =
        options.providerOverride ??
        resolveProviderName(job.channel, options.env);

    const release = rateLimiter.acquire(providerName || job.channel);

    try {
        const claimedJob = await deliveryRepo.claimDeliveryJob(job._id, {
            now,
            provider: providerName
        });

        if (!claimedJob) {
            throw new AppError(
                "Delivery job is already being processed or is no longer pending.",
                409,
                "DELIVERY_ALREADY_CLAIMED"
            );
        }

        try {
            const result = await dispatchToProvider(claimedJob, {
                ...options,
                providerOverride: providerName
            });

            if (result.success) {
                const sentJob = await deliveryRepo.recordProviderSuccess(
                    claimedJob._id,
                    result
                );

                await contracts.emitDeliveryEvent(DELIVERY_EVENTS.SENT, sentJob, {
                    providerMessageId: sentJob?.providerMessageId ?? null
                });

                return sentJob;
            }

            const failedJob = await deliveryRepo.recordProviderFailure(
                claimedJob._id,
                result
            );

            await contracts.emitDeliveryEvent(DELIVERY_EVENTS.FAILED, failedJob, {
                errorMessage: failedJob?.errorMessage ?? null
            });

            return failedJob;
        } catch {
            const failedJob = await deliveryRepo.recordProviderFailure(
                claimedJob._id,
                {
                    provider: providerName,
                    simulated: providerName
                        ? providerName.startsWith("MOCK_")
                        : true,
                    errorMessage: "Delivery provider execution failed unexpectedly."
                }
            );

            if (!failedJob) {
                throw new AppError(
                    "Delivery job could not be updated.",
                    500,
                    "DELIVERY_UPDATE_FAILED"
                );
            }

            await contracts.emitDeliveryEvent(DELIVERY_EVENTS.FAILED, failedJob, {
                errorMessage: failedJob.errorMessage
            });

            return failedJob;
        }
    } finally {
        release();
    }
};

export const queueDelivery = async (deliveryData, auth, options = {}) => {
    requireAuthContext(auth);
    validateQueuePayload(deliveryData);

    const contracts = options.contracts ?? getDeliveryContracts();
    const campaign = await contracts.findCampaignById(
        deliveryData.campaignId,
        auth.advisorId
    );

    await authorizeCampaignAccess(auth, campaign, contracts);

    if (
        deliveryData.advisorId &&
        String(deliveryData.advisorId) !== String(campaign.advisorId)
    ) {
        throw new AppError(
            "Client-supplied advisorId cannot override campaign ownership.",
            403,
            "FORBIDDEN"
        );
    }

    const payload = await buildValidatedJobPayload({
        deliveryData,
        campaign,
        createdByUserId: auth.userId,
        contracts,
        env: options.env
    });

    const job = await deliveryRepo.createDeliveryJob(payload);

    await contracts.emitDeliveryEvent(DELIVERY_EVENTS.QUEUED, job);

    return job;
};

export const queueDeliveryForAutomation = async (
    deliveryData,
    options = {}
) => {
    validateQueuePayload(deliveryData);

    const contracts = options.contracts ?? getDeliveryContracts();
    const campaign = await contracts.findCampaignById(
        deliveryData.campaignId,
        deliveryData.advisorId
    );

    if (!campaign) {
        throw new AppError(
            "Campaign not found.",
            404,
            "CAMPAIGN_NOT_FOUND"
        );
    }

    if (
        deliveryData.advisorId &&
        String(deliveryData.advisorId) !== String(campaign.advisorId)
    ) {
        throw new AppError(
            "Campaign ownership does not match the provided advisorId.",
            403,
            "ADVISOR_MISMATCH"
        );
    }

    const payload = await buildValidatedJobPayload({
        deliveryData,
        campaign,
        createdByUserId: options.triggeredByUserId ?? null,
        contracts,
        env: options.env
    });

    const job = await deliveryRepo.createDeliveryJob(payload);

    await contracts.emitDeliveryEvent(DELIVERY_EVENTS.QUEUED, job, {
        source: "AUTOMATION"
    });

    return job;
};

export const processDelivery = async (jobId, auth, options = {}) => {
    requireAuthContext(auth);
    assertValidObjectId(jobId, "deliveryJobId");

    const contracts = options.contracts ?? getDeliveryContracts();
    const job = await deliveryRepo.findDeliveryJobById(jobId);

    if (!job) {
        throw new AppError(
            "Delivery job not found.",
            404,
            "DELIVERY_NOT_FOUND"
        );
    }

    const campaign = await contracts.findCampaignById(
        job.campaignId,
        job.advisorId
    );

    await authorizeCampaignAccess(auth, campaign, contracts);

    return executeDeliveryJob(job, {
        ...options,
        contracts,
        preloadedCampaign: campaign
    });
};

export const processDeliveryInternal = async (jobId, options = {}) => {
    assertValidObjectId(jobId, "deliveryJobId");

    const job = await deliveryRepo.findDeliveryJobById(jobId);

    if (!job) {
        throw new AppError(
            "Delivery job not found.",
            404,
            "DELIVERY_NOT_FOUND"
        );
    }

    return executeDeliveryJob(job, options);
};

export const retryDelivery = async (jobId, auth, options = {}) => {
    requireAuthContext(auth);
    assertValidObjectId(jobId, "deliveryJobId");

    const contracts = options.contracts ?? getDeliveryContracts();
    const job = await deliveryRepo.findDeliveryJobById(jobId);

    if (!job) {
        throw new AppError(
            "Delivery job not found.",
            404,
            "DELIVERY_NOT_FOUND"
        );
    }

    const campaign = await contracts.findCampaignById(
        job.campaignId,
        job.advisorId
    );

    await authorizeCampaignAccess(auth, campaign, contracts);

    if (job.deliveryStatus !== "FAILED") {
        throw new AppError(
            "Only FAILED delivery jobs can be retried.",
            409,
            "INVALID_RETRY_STATUS"
        );
    }

    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRY_ATTEMPTS;
    if ((job.attempts ?? 0) >= maxRetries) {
        throw new AppError(
            "Maximum retry attempts reached for this delivery job.",
            409,
            "MAX_RETRIES_EXCEEDED"
        );
    }

    const retried = await deliveryRepo.retryFailedDeliveryJob(jobId);

    if (!retried) {
        throw new AppError(
            "Delivery job is no longer eligible for retry.",
            409,
            "RETRY_CONFLICT"
        );
    }

    return retried;
};

export const getDeliveryById = async (jobId, auth, options = {}) => {
    requireAuthContext(auth);
    assertValidObjectId(jobId, "deliveryJobId");

    const contracts = options.contracts ?? getDeliveryContracts();
    const job = await deliveryRepo.findDeliveryJobById(jobId);

    if (!job) {
        throw new AppError(
            "Delivery job not found.",
            404,
            "DELIVERY_NOT_FOUND"
        );
    }

    if (auth.role === "ADMIN") {
        return job;
    }

    const campaign = await contracts.findCampaignById(
        job.campaignId,
        job.advisorId
    );

    await authorizeCampaignAccess(auth, campaign, contracts);

    return job;
};

export const getDeliveryHistory = async (filters = {}, auth, options = {}) => {
    requireAuthContext(auth);

    const contracts = options.contracts ?? getDeliveryContracts();
    const scopedFilters = {
        campaignId: filters.campaignId || undefined,
        leadId: filters.leadId || undefined,
        channel: filters.channel || undefined,
        deliveryStatus: filters.deliveryStatus || undefined,
        provider: filters.provider || undefined,
        createdFrom: parseOptionalDate(filters.createdFrom, "createdFrom"),
        createdTo: parseOptionalDate(filters.createdTo, "createdTo"),
        scheduledFrom: parseOptionalDate(filters.scheduledFrom, "scheduledFrom"),
        scheduledTo: parseOptionalDate(filters.scheduledTo, "scheduledTo")
    };

    if (auth.role === "ADVISOR") {
        if (!auth.advisorId) {
            throw new AppError(
                "Advisor profile is required to access delivery history.",
                403,
                "ADVISOR_PROFILE_REQUIRED"
            );
        }

        if (
            filters.advisorId &&
            String(filters.advisorId) !== String(auth.advisorId)
        ) {
            throw new AppError(
                "You cannot access another advisor's delivery history.",
                403,
                "FORBIDDEN"
            );
        }

        scopedFilters.advisorId = String(auth.advisorId);
    } else if (auth.role === "MARKETING_SPECIALIST") {
        const allowedCampaignIds =
            await contracts.listAuthorizedCampaignIdsForSpecialist(auth.userId);

        if (
            filters.campaignId &&
            !allowedCampaignIds.includes(String(filters.campaignId))
        ) {
            throw new AppError(
                "You are not authorized to view delivery history for this campaign.",
                403,
                "CAMPAIGN_ASSIGNMENT_REQUIRED"
            );
        }

        scopedFilters.allowedCampaignIds = allowedCampaignIds;
    } else if (auth.role === "ADMIN") {
        if (filters.advisorId) {
            scopedFilters.advisorId = filters.advisorId;
        }
    } else {
        throw new AppError(
            "You do not have permission to view delivery history.",
            403,
            "FORBIDDEN"
        );
    }

    return deliveryRepo.listDeliveryJobs(scopedFilters, {
        page: filters.page,
        limit: filters.limit
    });
};