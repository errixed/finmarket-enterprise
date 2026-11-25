import mongoose from "mongoose";
import AutomationRule from "./models/AutomationRule.js";
import ActivityEvent from "./models/ActivityEvent.js";
import AutomationExecution from "./models/AutomationExecution.js";

// Phase II repository: every MongoDB query for the module lives here.
// Controllers never query the database, and services contain no queries.
//
// Duplicate prevention relies on the database, not on application memory:
//  * ActivityEvent.eventId has a unique index,
//  * AutomationExecution(eventId, automationRuleId) has a unique index,
//  * work is claimed with an atomic findOneAndUpdate on the status field.

const oid = (value) => new mongoose.Types.ObjectId(String(value));

const isDuplicateKey = (error) => error?.code === 11000;

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

// scope decides what the caller may see; filters are the (already validated)
// user filters. Both are combined with AND, so a filter can only narrow the
// result, never widen it.
//   scope: { kind: "ALL" }
//        | { kind: "OWNER", ownerId }
//        | { kind: "CAMPAIGNS", campaignIds }
export function buildMatch(scope, filters = {}, { dateField } = {}) {
    const match = {};

    if (scope.kind === "OWNER") {
        match.ownerId = oid(scope.ownerId);
    } else if (scope.kind === "CAMPAIGNS") {
        const ids = filters.campaignId
            ? scope.campaignIds.filter((id) => id === filters.campaignId)
            : scope.campaignIds;

        match.campaignId = { $in: ids.map(oid) };
    }

    if (filters.ownerId && scope.kind !== "OWNER") match.ownerId = oid(filters.ownerId);
    if (filters.campaignId && scope.kind !== "CAMPAIGNS") match.campaignId = oid(filters.campaignId);

    for (const key of [
        "trigger",
        "action",
        "enabled",
        "eventType",
        "entityType",
        "processingStatus",
        "source",
        "status",
        "simulated",
        "eventId"
    ]) {
        if (filters[key] !== undefined) match[key] = filters[key];
    }

    if (filters.entityId) match.entityId = oid(filters.entityId);
    if (filters.automationRuleId) match.automationRuleId = oid(filters.automationRuleId);

    if (dateField && (filters.from || filters.to)) {
        match[dateField] = {
            ...(filters.from ? { $gte: filters.from } : {}),
            ...(filters.to ? { $lte: filters.to } : {})
        };
    }

    return match;
}

async function listPage(model, match, { page, limit, sort }) {
    const [items, total] = await Promise.all([
        model.find(match)
            .sort(sort)
            .skip((page - 1) * limit)
            .limit(limit)
            .select("-__v")
            .lean(),
        model.countDocuments(match)
    ]);

    return { items, total };
}

const countMap = (rows) =>
    Object.fromEntries(rows.map((row) => [row._id, row.count]));

const facetCount = (facetResult) => facetResult[0]?.count ?? 0;

export const automationRepository = {
    // -----------------------------------------------------------------------
    // Automation rules
    // -----------------------------------------------------------------------

    async createRule(data) {
        const rule = await AutomationRule.create(data);

        return rule.toObject({ versionKey: false });
    },

    async findRuleById(id) {
        return AutomationRule.findById(id).select("-__v").lean();
    },

    async listRules(scope, filters, pagination) {
        return listPage(AutomationRule, buildMatch(scope, filters), {
            ...pagination,
            sort: { createdAt: -1, _id: -1 }
        });
    },

    async updateRule(id, changes) {
        return AutomationRule.findByIdAndUpdate(
            id,
            { $set: changes },
            { returnDocument: "after", runValidators: true }
        )
            .select("-__v")
            .lean();
    },

    // Enabled rules that react to this event type for this owner. A rule
    // tied to a campaign only reacts to events about that campaign.
    async findEnabledRulesForEvent({ ownerId, trigger, campaignId }) {
        return AutomationRule.find({
            ownerId: oid(ownerId),
            trigger,
            enabled: true,
            $or: [
                { campaignId: null },
                ...(campaignId ? [{ campaignId: oid(campaignId) }] : [])
            ]
        })
            .sort({ createdAt: 1, _id: 1 })
            .select("-__v")
            .lean();
    },

    async markRuleExecuted(ruleId, at) {
        await AutomationRule.updateOne(
            { _id: oid(ruleId) },
            { $set: { lastExecutedAt: at }, $inc: { executionCount: 1 } }
        );
    },

    // -----------------------------------------------------------------------
    // Activity events
    // -----------------------------------------------------------------------

    // Atomic duplicate prevention: the unique index on eventId decides. If
    // the event already exists the stored one is returned with created=false.
    async createEvent(data) {
        try {
            const event = await ActivityEvent.create(data);

            return { event: event.toObject({ versionKey: false }), created: true };
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;

            const existing = await ActivityEvent.findOne({ eventId: data.eventId })
                .select("-__v")
                .lean();

            return { event: existing, created: false };
        }
    },

    async findEventByEventId(eventId) {
        return ActivityEvent.findOne({ eventId }).select("-__v").lean();
    },

    // Only one caller can move an event into PROCESSING. A PROCESSING event
    // whose lease expired (backend restarted mid-processing) can be taken
    // over; this is safe because executions are idempotent.
    async claimEventForProcessing(eventId, now, leaseMs) {
        return ActivityEvent.findOneAndUpdate(
            {
                eventId,
                $or: [
                    { processingStatus: { $in: ["RECEIVED", "FAILED"] } },
                    {
                        processingStatus: "PROCESSING",
                        processingStartedAt: { $lt: new Date(now.getTime() - leaseMs) }
                    }
                ]
            },
            {
                $set: {
                    processingStatus: "PROCESSING",
                    processingStartedAt: now,
                    processingError: null
                }
            },
            { returnDocument: "after" }
        )
            .select("-__v")
            .lean();
    },

    async markEventProcessed(eventId, { matchedRuleCount, now }) {
        return ActivityEvent.findOneAndUpdate(
            { eventId },
            {
                $set: {
                    processingStatus: "PROCESSED",
                    processedAt: now,
                    processingError: null,
                    matchedRuleCount
                }
            },
            { returnDocument: "after" }
        )
            .select("-__v")
            .lean();
    },

    async markEventFailed(eventId, message) {
        await ActivityEvent.updateOne(
            { eventId },
            {
                $set: {
                    processingStatus: "FAILED",
                    processingError: String(message).slice(0, 300)
                }
            }
        );
    },

    async listEvents(scope, filters, pagination) {
        return listPage(
            ActivityEvent,
            buildMatch(scope, filters, { dateField: "occurredAt" }),
            { ...pagination, sort: { occurredAt: -1, _id: -1 } }
        );
    },

    // -----------------------------------------------------------------------
    // Automation executions (durable execution identity and schedule)
    // -----------------------------------------------------------------------

    // One execution per (eventId, automationRuleId). Returns created=false
    // when it already exists, so the same rule never runs twice per event.
    async createExecution(data) {
        try {
            const execution = await AutomationExecution.create(data);

            return { execution: execution.toObject({ versionKey: false }), created: true };
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;

            const existing = await AutomationExecution.findOne({
                eventId: data.eventId,
                automationRuleId: data.automationRuleId
            })
                .select("-__v")
                .lean();

            return { execution: existing, created: false };
        }
    },

    async findExecutionById(id) {
        return AutomationExecution.findById(id).select("-__v").lean();
    },

    async listExecutionsForEvent(eventId) {
        return AutomationExecution.find({ eventId })
            .sort({ createdAt: 1, _id: 1 })
            .select("-__v")
            .lean();
    },

    async listExecutions(scope, filters, pagination) {
        return listPage(
            AutomationExecution,
            buildMatch(scope, filters, { dateField: "createdAt" }),
            { ...pagination, sort: { createdAt: -1, _id: -1 } }
        );
    },

    // Ids of real (non-simulated) executions whose time has come.
    async findDueExecutionIds(now, limit) {
        const rows = await AutomationExecution.find({
            status: "PENDING",
            simulated: false,
            scheduledFor: { $lte: now }
        })
            .sort({ scheduledFor: 1, _id: 1 })
            .limit(limit)
            .select("_id")
            .lean();

        return rows.map((row) => String(row._id));
    },

    // Atomic claim: only one worker can move a PENDING, due execution to
    // PROCESSING. Everyone else gets null. This is what stops two workers
    // (or two processing requests) from running the same action.
    async claimExecution(id, workerId, now) {
        return AutomationExecution.findOneAndUpdate(
            {
                _id: oid(id),
                status: "PENDING",
                simulated: false,
                scheduledFor: { $lte: now }
            },
            {
                $set: { status: "PROCESSING", lockedBy: workerId, lockedAt: now, lastAttemptAt: now },
                $inc: { attemptCount: 1 }
            },
            { returnDocument: "after" }
        )
            .select("-__v")
            .lean();
    },

    // Final outcome. Guarded so only the worker holding the claim can write.
    async finishExecution(id, workerId, { status, result = null, error = null, now }) {
        return AutomationExecution.findOneAndUpdate(
            { _id: oid(id), status: "PROCESSING", lockedBy: workerId },
            {
                $set: {
                    status,
                    result,
                    error: {
                        code: error?.code ?? null,
                        message: error?.message ?? null
                    },
                    completedAt: now,
                    lockedBy: null,
                    lockedAt: null
                }
            },
            { returnDocument: "after" }
        )
            .select("-__v")
            .lean();
    },

    // Definite, retryable failure: back to PENDING with a later time.
    async scheduleRetry(id, workerId, { scheduledFor, error }) {
        return AutomationExecution.findOneAndUpdate(
            { _id: oid(id), status: "PROCESSING", lockedBy: workerId },
            {
                $set: {
                    status: "PENDING",
                    scheduledFor,
                    error: { code: error.code ?? null, message: error.message ?? null },
                    lockedBy: null,
                    lockedAt: null
                }
            },
            { returnDocument: "after" }
        )
            .select("-__v")
            .lean();
    },

    // An execution that has been PROCESSING longer than the lease belonged
    // to a worker that died. Whether the external call happened is unknown,
    // so it is marked UNCERTAIN and never retried automatically.
    async markStaleExecutionsUncertain(now, leaseMs) {
        const result = await AutomationExecution.updateMany(
            {
                status: "PROCESSING",
                lockedAt: { $lt: new Date(now.getTime() - leaseMs) }
            },
            {
                $set: {
                    status: "UNCERTAIN",
                    completedAt: now,
                    lockedBy: null,
                    lockedAt: null,
                    error: {
                        code: "LEASE_EXPIRED",
                        message: "The worker stopped before the outcome was recorded. Not retried automatically."
                    }
                }
            }
        );

        return result.modifiedCount ?? 0;
    },

    // -----------------------------------------------------------------------
    // Analytics (MongoDB aggregation; nothing is loaded into memory)
    // -----------------------------------------------------------------------

    async summarizeRules(scope) {
        const match = buildMatch(scope);
        const [row] = await AutomationRule.aggregate([
            { $match: match },
            {
                $facet: {
                    total: [{ $count: "count" }],
                    enabled: [{ $match: { enabled: true } }, { $count: "count" }],
                    byTrigger: [{ $group: { _id: "$trigger", count: { $sum: 1 } } }],
                    byAction: [{ $group: { _id: "$action", count: { $sum: 1 } } }]
                }
            }
        ]);

        const total = facetCount(row.total);
        const enabled = facetCount(row.enabled);

        return {
            total,
            enabled,
            disabled: total - enabled,
            byTrigger: countMap(row.byTrigger),
            byAction: countMap(row.byAction)
        };
    },

    async summarizeEvents(scope) {
        const match = buildMatch(scope);
        const [row] = await ActivityEvent.aggregate([
            { $match: match },
            {
                $facet: {
                    total: [{ $count: "count" }],
                    withMatchingRules: [
                        { $match: { matchedRuleCount: { $gt: 0 } } },
                        { $count: "count" }
                    ],
                    byType: [{ $group: { _id: "$eventType", count: { $sum: 1 } } }],
                    byProcessingStatus: [
                        { $group: { _id: "$processingStatus", count: { $sum: 1 } } }
                    ]
                }
            }
        ]);

        return {
            total: facetCount(row.total),
            withMatchingRules: facetCount(row.withMatchingRules),
            byType: countMap(row.byType),
            byProcessingStatus: countMap(row.byProcessingStatus)
        };
    },

    // Simulated and executed actions are counted separately.
    async summarizeExecutions(scope) {
        const match = buildMatch(scope);
        const [row] = await AutomationExecution.aggregate([
            { $match: match },
            {
                $facet: {
                    simulated: [
                        { $match: { simulated: true } },
                        { $group: { _id: "$action", count: { $sum: 1 } } }
                    ],
                    executed: [
                        { $match: { simulated: false } },
                        { $group: { _id: "$action", count: { $sum: 1 } } }
                    ],
                    executedByStatus: [
                        { $match: { simulated: false } },
                        { $group: { _id: "$status", count: { $sum: 1 } } }
                    ]
                }
            }
        ]);

        const simulatedByAction = countMap(row.simulated);
        const executedByAction = countMap(row.executed);
        const sum = (map) => Object.values(map).reduce((a, b) => a + b, 0);

        return {
            simulated: { total: sum(simulatedByAction), byAction: simulatedByAction },
            executed: {
                total: sum(executedByAction),
                byAction: executedByAction,
                byStatus: countMap(row.executedByStatus)
            }
        };
    }
};

export default automationRepository;
