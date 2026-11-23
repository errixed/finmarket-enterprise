import * as sharedAuthentication from "../../middleware/authMiddleware.js";
import AppError from "../../utils/AppError.js";

// Authentication for this module is the SHARED middleware owned by Member 1
// (JWT verification, user lookup, req.auth / req.user). This module never
// verifies tokens itself.
//
// The shared middleware is picked up by name (`authenticate`). If it is not
// available, every request is refused instead of being allowed through, so
// the endpoints can never be reached unauthenticated by accident.
//
// The namespace import is deliberate: it keeps this file loadable even while
// the shared file has no exports yet.

export function failClosedAuthenticate(req, res, next) {
    next(new AppError(
        "Authentication is not available.",
        503,
        "AUTH_UNAVAILABLE"
    ));
}

export function resolveAuthenticate(shared = sharedAuthentication) {
    const authenticate = shared.authenticate ?? shared.default;

    return typeof authenticate === "function"
        ? authenticate
        : failClosedAuthenticate;
}
