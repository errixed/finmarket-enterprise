import { identityRepository } from "./identityRepository.js";
import { assignmentRepository } from "./assignmentRepository.js";

import { ROLES } from "./identityConstants.js";
import { validId, fail } from "./identityValidation.js";

export const authorizationService = {
    async getAcceptedAdvisorIds(specialistUserId) {
        const userId = validId(
            specialistUserId,
            "Specialist User ID"
        );

        const specialist =
            await identityRepository.findUserById(userId);

        if (
            !specialist ||
            !specialist.isActive ||
            specialist.role !== ROLES.MARKETING_SPECIALIST
        ) {
            return [];
        }

        const advisorIds =
            await assignmentRepository.findAcceptedAdvisorIds(
                userId
            );

        const results = await Promise.all(
            advisorIds.map(async id => {
                const advisorId = String(id);

                const exists =
                    await this.advisorExists(advisorId);

                return exists ? advisorId : null;
            })
        );

        return results.filter(id => id !== null);
    },
    async getAdvisorIdForUser(userId) {
        validId(userId, "User ID");

        const user =
            await identityRepository.findUserById(userId);

        if (
            !user ||
            !user.isActive ||
            user.role !== ROLES.ADVISOR
        ) {
            return null;
        }

        const profile =
            await identityRepository.findAdvisorByUserId(
                userId
            );

        return profile ? String(profile._id) : null;
    },

    async advisorExists(advisorId) {
        validId(advisorId, "Advisor ID");

        const profile =
            await identityRepository.findAdvisorById(
                advisorId
            );

        if (!profile) return false;

        const user =
            await identityRepository.findUserById(
                profile.userId
            );

        return Boolean(
            user &&
            user.isActive &&
            user.role === ROLES.ADVISOR
        );
    },

    async ownsAdvisorProfile(userId, advisorId) {
        const resolved =
            await this.getAdvisorIdForUser(userId);

        return resolved !== null &&
            resolved === String(advisorId);
    },

    async hasAcceptedAssignment(
        advisorId,
        specialistUserId
    ) {
        validId(advisorId, "Advisor ID");
        validId(
            specialistUserId,
            "Specialist User ID"
        );

        const [advisor, specialist] = await Promise.all([
            this.advisorExists(advisorId),
            identityRepository.findUserById(
                specialistUserId
            )
        ]);

        if (
            !advisor ||
            !specialist ||
            !specialist.isActive ||
            specialist.role !== ROLES.MARKETING_SPECIALIST
        ) {
            return false;
        }

        return assignmentRepository.hasAcceptedRelationship(
            advisorId,
            specialistUserId
        );
    },

    async requireAdvisorOwnership(auth, advisorId) {
        if (
            !auth ||
            auth.role !== ROLES.ADVISOR ||
            auth.advisorId !== String(advisorId)
        ) {
            fail(
                "Advisor ownership required.",
                403,
                "FORBIDDEN"
            );
        }

        return true;
    },

    async requireAcceptedAssignment(
        advisorId,
        specialistUserId
    ) {
        const accepted =
            await this.hasAcceptedAssignment(
                advisorId,
                specialistUserId
            );

        if (!accepted) {
            fail(
                "An accepted advisor-specialist relationship is required.",
                403,
                "ASSIGNMENT_REQUIRED"
            );
        }

        return true;
    },

    async requireCampaignAccess(
        auth,
        campaign,
        hasCampaignAssignment
    ) {
        if (!auth?.userId) {
            fail(
                "Authentication required.",
                401,
                "UNAUTHORIZED"
            );
        }
        if (!campaign) {
            fail(
                "Campaign not found.",
                404,
                "NOT_FOUND"
            );
        }

        const advisorId = String(campaign.advisorId);

        if (
            auth.role === ROLES.ADVISOR &&
            auth.advisorId === advisorId
        ) {
            return true;
        }

        if (auth.role !== ROLES.MARKETING_SPECIALIST) {
            fail(
                "Campaign access denied.",
                403,
                "FORBIDDEN"
            );
        }

        await this.requireAcceptedAssignment(
            advisorId,
            auth.userId
        );

        if (typeof hasCampaignAssignment !== "function") {
            fail(
                "Campaign assignment validation is required.",
                403,
                "CAMPAIGN_ASSIGNMENT_REQUIRED"
            );
        }

        const assigned = await hasCampaignAssignment(
            campaign,
            auth.userId
        );

        if (!assigned) {
            fail(
                "You are not assigned to this campaign.",
                403,
                "CAMPAIGN_ASSIGNMENT_REQUIRED"
            );
        }

        return true;
    }
};