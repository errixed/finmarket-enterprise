import { identityRepository } from "./identityRepository.js";
import { assignmentRepository } from "./assignmentRepository.js";

import {
    ASSIGNMENT_STATUSES as STATUS,
    ROLES
} from "./identityConstants.js";

import {
    fail,
    normalizeEmail,
    validId,
    requireObject,
    allowOnly
} from "./identityValidation.js";

function requireAdvisor(auth) {
    if (
        auth?.role !== ROLES.ADVISOR ||
        !auth.advisorId
    ) {
        fail(
            "Advisor access required.",
            403,
            "FORBIDDEN"
        );
    }

    return auth.advisorId;
}

function requireSpecialist(auth) {
    if (auth?.role !== ROLES.MARKETING_SPECIALIST) {
        fail(
            "Marketing Specialist access required.",
            403,
            "FORBIDDEN"
        );
    }

    return auth.userId;
}

async function requireInvitationOwner(id, auth) {
    const assignmentId = validId(id, "Invitation ID");

    const record = await assignmentRepository.findById(
        assignmentId
    );

    if (!record) {
        fail(
            "Invitation not found.",
            404,
            "NOT_FOUND"
        );
    }

    if (
        String(record.specialistUserId) !== auth.userId
    ) {
        fail(
            "You cannot respond to this invitation.",
            403,
            "FORBIDDEN"
        );
    }

    return record;
}

export const assignmentService = {
    async invite(data, auth) {
        const advisorId = requireAdvisor(auth);

        requireObject(data);

        allowOnly(data, [
            "specialistUserId",
            "specialistEmail"
        ]);

        let specialist;

        if (data.specialistUserId !== undefined) {
            const specialistUserId = validId(
                data.specialistUserId,
                "Specialist User ID"
            );

            specialist =
                await identityRepository.findUserById(
                    specialistUserId
                );
        } else if (data.specialistEmail !== undefined) {
            const email = normalizeEmail(
                data.specialistEmail
            );

            specialist =
                await identityRepository.findUserByEmail(
                    email
                );
        } else {
            fail(
                "Provide specialistUserId or specialistEmail."
            );
        }

        if (
            !specialist ||
            specialist.role !== ROLES.MARKETING_SPECIALIST ||
            !specialist.isActive
        ) {
            fail(
                "An active Marketing Specialist account is required.",
                400,
                "INVALID_SPECIALIST"
            );
        }

        const existing =
            await assignmentRepository.findActivePair(
                advisorId,
                specialist._id
            );

        if (existing) {
            fail(
                "An active invitation or assignment already exists.",
                409,
                "DUPLICATE_ASSIGNMENT"
            );
        }

        const invitation =
            await assignmentRepository.create({
                advisorId,
                specialistUserId: specialist._id,
                status: STATUS.PENDING
            });

        return invitation;
    },

    async listInvitations(auth) {
        if (auth.role === ROLES.ADVISOR) {
            return assignmentRepository.listForAdvisor(
                requireAdvisor(auth),
                STATUS.PENDING
            );
        }

        if (auth.role === ROLES.MARKETING_SPECIALIST) {
            return assignmentRepository.listForSpecialist(
                requireSpecialist(auth),
                STATUS.PENDING
            );
        }

        fail(
            "Access denied.",
            403,
            "FORBIDDEN"
        );
    },

    async accept(id, auth) {
        const specialistUserId =
            requireSpecialist(auth);

        await requireInvitationOwner(id, auth);

        const accepted =
            await assignmentRepository.accept(
                validId(id, "Invitation ID"),
                specialistUserId
            );

        if (!accepted) {
            fail(
                "Invitation is no longer pending.",
                409,
                "INVALID_ASSIGNMENT_STATE"
            );
        }

        return accepted;
    },

    async decline(id, auth) {
        const specialistUserId =
            requireSpecialist(auth);

        await requireInvitationOwner(id, auth);

        const declined =
            await assignmentRepository.decline(
                validId(id, "Invitation ID"),
                specialistUserId
            );

        if (!declined) {
            fail(
                "Invitation is no longer pending.",
                409,
                "INVALID_ASSIGNMENT_STATE"
            );
        }

        return declined;
    },

    async listAssignments(auth) {
        if (auth.role === ROLES.ADVISOR) {
            return assignmentRepository.listForAdvisor(
                requireAdvisor(auth),
                STATUS.ACCEPTED
            );
        }

        if (auth.role === ROLES.MARKETING_SPECIALIST) {
            return assignmentRepository.listForSpecialist(
                requireSpecialist(auth),
                STATUS.ACCEPTED
            );
        }

        fail(
            "Access denied.",
            403,
            "FORBIDDEN"
        );
    },

    async revoke(id, auth) {
        const advisorId = requireAdvisor(auth);
        const assignmentId = validId(
            id,
            "Assignment ID"
        );

        const record =
            await assignmentRepository.findById(
                assignmentId
            );

        if (!record) {
            fail(
                "Assignment not found.",
                404,
                "NOT_FOUND"
            );
        }

        if (String(record.advisorId) !== advisorId) {
            fail(
                "You cannot revoke this assignment.",
                403,
                "FORBIDDEN"
            );
        }

        const revoked =
            await assignmentRepository.revoke(
                assignmentId,
                advisorId
            );

        if (!revoked) {
            fail(
                "Only accepted assignments can be revoked.",
                409,
                "INVALID_ASSIGNMENT_STATE"
            );
        }

        return revoked;
    }
};