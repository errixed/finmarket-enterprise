import mongoose from "mongoose";
import DeliveryJob from "../models/DeliveryJob.js";
import AppError from "../../../utils/AppError.js";

const { Types } = mongoose;

const UPDATABLE_FIELDS = new Set([
    "deliveryStatus",
    "attempts",
    "sentAt",
    "processingStartedAt",
    "lastAttemptAt",
    "provider",
    "providerMessageId",
    "errorMessage",
    "simulated"
]);

export const STATUS_TRANSITIONS = Object.freeze({
    PENDING: ["PROCESSING", "CANCELLED"],
    PROCESSING: ["SENT", "FAILED"],
    SENT: [],
    FAILED: [],
    CANCELLED: []
});

const toObjectId = (value, fieldName) => {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    if (!Types.ObjectId.isValid(value)) {
        throw new AppError(
            `Invalid ${fieldName}.`,
            400,
            "INVALID_OBJECT_ID"
        );
    }

    return new Types.ObjectId(String(value));
};

const serializeDeliveryJob = (doc) => {
    if (!doc) return null;

    const raw = typeof doc.toObject === "function" ? doc.toObject() : doc;

    return {
        ...raw,
        _id: String(raw._id),
        advisorId: raw.advisorId ? String(raw.advisorId) : null,
        campaignId: raw.campaignId ? String(raw.campaignId) : null,
        leadId: raw.leadId ? String(raw.leadId) : null,
        createdByUserId: raw.createdByUserId ? String(raw.createdByUserId) : null
    };
};

const buildFilterQuery = (filters = {}) => {
    const query = {};

    if (filters.advisorId) {
        query.advisorId = toObjectId(filters.advisorId, "advisorId");
    }

    if (filters.campaignId) {
        query.campaignId = toObjectId(filters.campaignId, "campaignId");
    }

    if (Array.isArray(filters.allowedCampaignIds)) {
        const allowedIds = filters.allowedCampaignIds.map((id) =>
            toObjectId(id, "campaignId")
        );

        if (query.campaignId) {
            const isAllowed = allowedIds.some((id) => id.equals(query.campaignId));
            if (!isAllowed) {
                return { _id: { $in: [] } };
            }
        } else {
            query.campaignId = { $in: allowedIds };
        }
    }

    if (filters.leadId) {
        query.leadId = toObjectId(filters.leadId, "leadId");
    }

    if (filters.channel) {
        query.channel = String(filters.channel).toUpperCase();
    }

    if (filters.deliveryStatus) {
        query.deliveryStatus = String(filters.deliveryStatus).toUpperCase();
    }

    if (filters.provider) {
        query.provider = String(filters.provider).toUpperCase();
    }

    if (filters.createdFrom || filters.createdTo) {
        query.createdAt = {};
        if (filters.createdFrom) {
            query.createdAt.$gte = new Date(filters.createdFrom);
        }
        if (filters.createdTo) {
            query.createdAt.$lte = new Date(filters.createdTo);
        }
    }

    if (filters.scheduledFrom || filters.scheduledTo) {
        query.scheduledAt = {};
        if (filters.scheduledFrom) {
            query.scheduledAt.$gte = new Date(filters.scheduledFrom);
        }
        if (filters.scheduledTo) {
            query.scheduledAt.$lte = new Date(filters.scheduledTo);
        }
    }

    return query;
};

export const createDeliveryJob = async (jobData) => {
    const payload = {
        advisorId: toObjectId(jobData.advisorId, "advisorId"),
        campaignId: toObjectId(jobData.campaignId, "campaignId"),
        leadId: jobData.leadId ? toObjectId(jobData.leadId, "leadId") : null,
        createdByUserId: jobData.createdByUserId
            ? toObjectId(jobData.createdByUserId, "createdByUserId")
            : null,
        channel: jobData.channel,
        recipientEmail: jobData.recipientEmail ?? null,
        content: {
            subject: jobData.content?.subject ?? "",
            body: jobData.content?.body
        },
        deliveryStatus: "PENDING",
        provider: jobData.provider ?? null,
        scheduledAt: jobData.scheduledAt ? new Date(jobData.scheduledAt) : null,
        idempotencyKey: jobData.idempotencyKey ?? null,
        attempts: 0,
        simulated: jobData.simulated ?? true
    };

    const duplicateFilter = {
        deliveryStatus: { $in: ["PENDING", "PROCESSING"] },
        campaignId: payload.campaignId,
        leadId: payload.leadId,
        channel: payload.channel,
        "content.subject": payload.content.subject,
        "content.body": payload.content.body,
        scheduledAt: payload.scheduledAt
    };

    const existing = await DeliveryJob.findOne(duplicateFilter).lean();

    if (existing) {
        throw new AppError(
            "An identical delivery job is already queued.",
            409,
            "DUPLICATE_DELIVERY"
        );
    }

    try {
        const created = await DeliveryJob.create(payload);
        return serializeDeliveryJob(created);
    } catch (error) {
        if (error?.code === 11000) {
            throw new AppError(
                "A delivery job with this idempotencyKey already exists.",
                409,
                "DUPLICATE_DELIVERY"
            );
        }
        if (error?.name === "ValidationError") {
            error.statusCode = 400;
        }
        throw error;
    }
};

export const findDeliveryJobById = async (id) => {
    if (!Types.ObjectId.isValid(id)) {
        return null;
    }

    const job = await DeliveryJob.findById(id).lean();
    return serializeDeliveryJob(job);
};

export const listDeliveryJobs = async (filters = {}, options = {}) => {
    const query = buildFilterQuery(filters);

    const parsedPage = Number.parseInt(options.page ?? filters.page ?? 1, 10);
    const parsedLimit = Number.parseInt(options.limit ?? filters.limit ?? 20, 10);

    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const limit =
        Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, 100)
            : 20;
    const skip = (page - 1) * limit;

    const [docs, total] = await Promise.all([
        DeliveryJob.find(query)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        DeliveryJob.countDocuments(query)
    ]);

    return {
        items: docs.map(serializeDeliveryJob),
        pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        }
    };
};

export const getDeliveryJobs = async (filters = {}) => {
    const query = buildFilterQuery(filters);
    const docs = await DeliveryJob.find(query)
        .sort({ createdAt: -1, _id: -1 })
        .lean();

    return docs.map(serializeDeliveryJob);
};

export const findPendingDeliveries = async (limit = 50) => {
    const docs = await DeliveryJob.find({ deliveryStatus: "PENDING" })
        .sort({ createdAt: 1, _id: 1 })
        .limit(limit)
        .lean();

    return docs.map(serializeDeliveryJob);
};

export const findDueScheduledDeliveries = async (now = new Date(), limit = 50) => {
    const docs = await DeliveryJob.find({
        deliveryStatus: "PENDING",
        $or: [
            { scheduledAt: null },
            { scheduledAt: { $lte: now } }
        ]
    })
        .sort({ scheduledAt: 1, createdAt: 1, _id: 1 })
        .limit(limit)
        .lean();

    return docs.map(serializeDeliveryJob);
};

export const claimDeliveryJob = async (id, options = {}) => {
    if (!Types.ObjectId.isValid(id)) {
        return null;
    }

    const now = options.now ? new Date(options.now) : new Date();

    const filter = {
        _id: new Types.ObjectId(String(id)),
        deliveryStatus: "PENDING",
        $or: [
            { scheduledAt: null },
            { scheduledAt: { $exists: false } },
            { scheduledAt: { $lte: now } }
        ]
    };

    const setFields = {
        deliveryStatus: "PROCESSING",
        processingStartedAt: now,
        lastAttemptAt: now
    };

    if (options.provider) {
        setFields.provider = options.provider;
    }

    const claimed = await DeliveryJob.findOneAndUpdate(
        filter,
        {
            $set: setFields,
            $inc: { attempts: 1 }
        },
        {
            returnDocument: "after",
            runValidators: true
        }
    ).lean();

    return serializeDeliveryJob(claimed);
};

export const updateDeliveryJob = async (id, updateData = {}) => {
    if (!Types.ObjectId.isValid(id)) {
        return null;
    }

    const current = await DeliveryJob.findById(id).lean();
    if (!current) {
        return null;
    }

    const changes = Object.fromEntries(
        Object.entries(updateData).filter(([key]) => UPDATABLE_FIELDS.has(key))
    );

    const nextStatus = changes.deliveryStatus;

    if (
        nextStatus !== undefined &&
        !STATUS_TRANSITIONS[current.deliveryStatus]?.includes(nextStatus)
    ) {
        throw new AppError(
            `Invalid delivery status transition: ${current.deliveryStatus} to ${nextStatus}.`,
            409,
            "INVALID_STATUS_TRANSITION"
        );
    }

    const updated = await DeliveryJob.findOneAndUpdate(
        {
            _id: current._id,
            deliveryStatus: current.deliveryStatus
        },
        { $set: changes },
        {
            returnDocument: "after",
            runValidators: true
        }
    ).lean();

    if (!updated) {
        throw new AppError(
            "Delivery job status changed concurrently.",
            409,
            "CONCURRENT_STATUS_CONFLICT"
        );
    }

    return serializeDeliveryJob(updated);
};

export const recordProviderSuccess = async (id, result = {}) => {
    if (!Types.ObjectId.isValid(id)) {
        return null;
    }

    const updated = await DeliveryJob.findOneAndUpdate(
        {
            _id: new Types.ObjectId(String(id)),
            deliveryStatus: "PROCESSING"
        },
        {
            $set: {
                deliveryStatus: "SENT",
                sentAt: result.sentAt ? new Date(result.sentAt) : new Date(),
                provider: result.provider ?? null,
                providerMessageId: result.providerMessageId ?? null,
                simulated: result.simulated ?? true,
                errorMessage: null
            }
        },
        {
            returnDocument: "after",
            runValidators: true
        }
    ).lean();

    return serializeDeliveryJob(updated);
};

export const recordProviderFailure = async (id, result = {}) => {
    if (!Types.ObjectId.isValid(id)) {
        return null;
    }

    const updated = await DeliveryJob.findOneAndUpdate(
        {
            _id: new Types.ObjectId(String(id)),
            deliveryStatus: "PROCESSING"
        },
        {
            $set: {
                deliveryStatus: "FAILED",
                sentAt: null,
                provider: result.provider ?? null,
                providerMessageId: null,
                simulated: result.simulated ?? true,
                errorMessage: result.errorMessage ?? "Delivery processing failed."
            }
        },
        {
            returnDocument: "after",
            runValidators: true
        }
    ).lean();

    return serializeDeliveryJob(updated);
};

export const retryFailedDeliveryJob = async (id) => {
    if (!Types.ObjectId.isValid(id)) {
        return null;
    }

    const retried = await DeliveryJob.findOneAndUpdate(
        {
            _id: new Types.ObjectId(String(id)),
            deliveryStatus: "FAILED"
        },
        {
            $set: {
                deliveryStatus: "PENDING",
                processingStartedAt: null,
                providerMessageId: null,
                errorMessage: null
            }
        },
        {
            returnDocument: "after",
            runValidators: true
        }
    ).lean();

    return serializeDeliveryJob(retried);
};

export const countDeliveryJobs = async (filters = {}) => {
    const query = buildFilterQuery(filters);
    return DeliveryJob.countDocuments(query);
};