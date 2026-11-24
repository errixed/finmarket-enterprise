import AppError from "../utils/AppError.js";

import {
    ROLES,
    ROLE_RULES
} from "../modules/identity/identityConstants.js";

export function authorizeRoles(...allowedRoles) {
    return (req, res, next) => {
        if (!req.auth) {
            return next(new AppError(
                "Authentication required.",
                401,
                "UNAUTHORIZED"
            ));
        }

        if (!allowedRoles.includes(req.auth.role)) {
            return next(new AppError(
                "You do not have permission to perform this action.",
                403,
                "FORBIDDEN"
            ));
        }

        return next();
    };
}

export function hasRolePermission(role, permission) {
    const permissions = ROLE_RULES[role];

    return Array.isArray(permissions) &&
        permissions.includes(permission);
}

export function authorizePermissions(...requiredPermissions) {
    if (requiredPermissions.length === 0) {
        throw new TypeError(
            "At least one permission is required."
        );
    }

    return (req, res, next) => {
        if (!req.auth) {
            return next(new AppError(
                "Authentication required.",
                401,
                "UNAUTHORIZED"
            ));
        }

        const permissions = ROLE_RULES[req.auth.role];

        if (!Array.isArray(permissions)) {
            return next(new AppError(
                "Invalid user role.",
                403,
                "FORBIDDEN"
            ));
        }

        const allowed = requiredPermissions.every(
            permission =>
                hasRolePermission(req.auth.role, permission)
        );

        if (!allowed) {
            return next(new AppError(
                "You do not have permission to perform this action.",
                403,
                "FORBIDDEN"
            ));
        }

        return next();
    };
}

export function requireAdvisorOwnership(param = "advisorId") {
    return (req, res, next) => {
        if (
            !req.auth ||
            req.auth.role !== ROLES.ADVISOR ||
            req.auth.advisorId !== req.params[param]
        ) {
            return next(new AppError(
                "You do not own this resource.",
                403,
                "FORBIDDEN"
            ));
        }

        return next();
    };
}

export default authorizeRoles;