import { adminRepository as repository }
    from "./adminRepository.js";

import {
    ROLES,
    ROLE_RULES
} from "./identityConstants.js";

import {
    validId,
    requireObject,
    allowOnly,
    fail
} from "./identityValidation.js";

function publicUser(user) {
    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
    };
}

function requireAdministrator(auth, permission) {
    if (!auth?.userId) {
        fail(
            "Authentication required.",
            401,
            "UNAUTHORIZED"
        );
    }

    if (
        auth.role !== ROLES.ADMIN ||
        !ROLE_RULES[ROLES.ADMIN].includes(permission)
    ) {
        fail(
            "Administrative permission required.",
            403,
            "FORBIDDEN"
        );
    }
}

export const adminService = {
    async listUsers(auth) {
        requireAdministrator(auth, "MANAGE_USERS");

        const users = await repository.listUsers();

        return users.map(publicUser);
    },

    async getUser(id, auth) {
        requireAdministrator(auth, "MANAGE_USERS");

        const userId = validId(id, "User ID");

        const user = await repository.findUserById(userId);

        if (!user) {
            fail(
                "User not found.",
                404,
                "NOT_FOUND"
            );
        }

        return publicUser(user);
    },

    async updateUserStatus(id, data, auth) {
        requireAdministrator(auth, "MANAGE_USERS");

        const userId = validId(id, "User ID");

        requireObject(data);
        allowOnly(data, ["isActive"]);

        if (typeof data.isActive !== "boolean") {
            fail("isActive must be a boolean.");
        }

        if (
            userId.toLowerCase() ===
                String(auth.userId).toLowerCase() &&
            data.isActive === false
        ) {
            fail(
                "An Administrator cannot deactivate their own account.",
                409,
                "SELF_DEACTIVATION_DENIED"
            );
        }

        const user = await repository.updateUserStatus(
            userId,
            data.isActive
        );

        if (!user) {
            fail(
                "User not found.",
                404,
                "NOT_FOUND"
            );
        }

        return {
            id: String(user._id),
            name: user.name,
            email: user.email,
            role: user.role,
            isActive: user.isActive
        };
    },

    async listAssignments(auth) {
        requireAdministrator(
            auth,
            "REVIEW_ASSIGNMENTS"
        );

        return repository.listAssignments();
    },

    async revokeAssignment(id, auth) {
        requireAdministrator(
            auth,
            "REVIEW_ASSIGNMENTS"
        );

        const assignmentId = validId(
            id,
            "Assignment ID"
        );

        const assignment =
            await repository.revokeAssignment(
                assignmentId
            );

        if (!assignment) {
            fail(
                "Accepted assignment not found.",
                404,
                "NOT_FOUND"
            );
        }

        return assignment;
    },

    listRoles(auth) {
        requireAdministrator(
            auth,
            "MANAGE_PERMISSIONS"
        );

        return Object.values(ROLES).map(role => ({
            role,
            permissions: [...ROLE_RULES[role]]
        }));
    },

    async getUserPermissions(id, auth) {
        requireAdministrator(
            auth,
            "MANAGE_PERMISSIONS"
        );

        const userId = validId(id, "User ID");

        const user = await repository.findUserById(
            userId
        );

        if (!user) {
            fail(
                "User not found.",
                404,
                "NOT_FOUND"
            );
        }

        return {
            userId: String(user._id),
            role: user.role,
            isActive: user.isActive,
            permissions: user.isActive
                ? [...(ROLE_RULES[user.role] ?? [])]
                : []
        };
    }
};