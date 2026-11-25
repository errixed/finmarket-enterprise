import Lead from "./models/Lead.js";

const toPlainObject = record => record?.toObject
    ? record.toObject()
    : record;

export default {
    async create(record) {
        const created = await Lead.create(record);
        return toPlainObject(created);
    },

    async findById(id, advisorId = undefined) {
        const filter = { _id: id };
        if (advisorId !== undefined) filter.advisorId = advisorId;
        return Lead.findOne(filter).lean().exec();
    },

    async findByAdvisor(advisorId, filters, { page, limit }) {
        const skip = (page - 1) * limit;
        const [data, total] = await Promise.all([
            Lead.find({ advisorId, ...filters })
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
                .exec(),
            Lead.countDocuments({ advisorId, ...filters }).exec()
        ]);

        return {
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    },

    async findDuplicateContact(advisorId, email, excludeId = null) {
        const filter = { advisorId, email };
        if (excludeId) filter._id = { $ne: excludeId };
        return Lead.exists(filter).exec();
    },

    async update(id, advisorId, changes) {
        return Lead.findOneAndUpdate(
            { _id: id, advisorId },
            { $set: changes },
            {
                returnDocument: "after",
                runValidators: true,
                context: "query"
            }
        ).lean().exec();
    },

    async findEligibleForMarketing(advisorId, filters = {}) {
        return Lead.find({
            ...filters,
            advisorId,
            marketingConsent: true,
            unsubscribedAt: null
        }).select("_id advisorId name email interest status marketingConsent consentRecordedAt unsubscribedAt source").lean().exec();
    }
};
