import User from "./models/User.js";
import AdvisorProfile from "./models/AdvisorProfile.js";
import { ROLES } from "./identityConstants.js";

function options(session) {
    return session ? { session } : {};
}

export const identityRepository = {
    async createUser(data, session = null) {
        const [user] = await User.create(
            [data],
            options(session)
        );

        return user;
    },

    async findUserByEmail(email, includePassword = false) {
        let query = User.findOne({ email });

        if (includePassword) {
            query = query.select("+passwordHash");
        }

        return query.exec();
    },

    async findUserById(id) {
        return User.findById(id);
    },

    async createAdvisorProfile(data, session = null) {
        const [profile] = await AdvisorProfile.create(
            [data],
            options(session)
        );

        return profile;
    },

    async findAdvisorByUserId(userId) {
        return AdvisorProfile.findOne({ userId });
    },

    async findAdvisorById(id) {
        return AdvisorProfile.findById(id);
    },

    async findAllPublicAdvisors() {
        const profiles = await AdvisorProfile.find({
            isPublic: true
        })
            .sort({ createdAt: -1 })
            .populate({
                path: "userId",
                match: {
                    isActive: true,
                    role: ROLES.ADVISOR
                },
                select: "name"
            })
            .lean();

        return profiles.filter(
            profile => profile.userId !== null
        );
    },

    async findPublicAdvisorById(id) {
        const profile = await AdvisorProfile.findOne({
            _id: id,
            isPublic: true
        })
            .populate({
                path: "userId",
                match: {
                    isActive: true,
                    role: ROLES.ADVISOR
                },
                select: "name"
            })
            .lean();

        if (!profile || !profile.userId) {
            return null;
        }

        return profile;
    },

    async updateAdvisorProfile(id, changes) {
        return AdvisorProfile.findByIdAndUpdate(
            id,
            { $set: changes },
            {
                returnDocument: "after",
                runValidators: true
            }
        );
    }
};