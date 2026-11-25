import jwt from "jsonwebtoken";

import config from "../config.js";

import { identityRepository } from "../modules/identity/identityRepository.js";
import { ROLES } from "../modules/identity/identityConstants.js";

import AppError from "../utils/AppError.js";

export async function authenticate(req, res, next) {
    try {
        const authorization = req.headers.authorization;

        if (
            !authorization ||
            !/^Bearer \S+$/i.test(authorization)
        ) {
            throw new AppError(
                "Authentication required.",
                401,
                "UNAUTHORIZED"
            );
        }

        const token = authorization.replace(
            /^Bearer /i,
            ""
        );

        let payload;

        try {
            payload = jwt.verify(
                token,
                config.JWT_SECRET,
                {
                    algorithms: ["HS256"],
                    issuer: config.JWT_ISSUER,
                    audience: config.JWT_AUDIENCE
                }
            );
        } catch {
            throw new AppError(
                "Invalid or expired authentication token.",
                401,
                "INVALID_TOKEN"
            );
        }

        if (
            !payload ||
            typeof payload !== "object" ||
            !/^[a-f0-9]{24}$/i.test(payload.sub)
        ) {
            throw new AppError(
                "Invalid authentication token.",
                401,
                "INVALID_TOKEN"
            );
        }

        const user =
            await identityRepository.findUserById(
                payload.sub
            );

        if (!user || !user.isActive) {
            throw new AppError(
                "Account unavailable.",
                401,
                "UNAUTHORIZED"
            );
        }

        let advisorId = null;

        if (user.role === ROLES.ADVISOR) {
            const profile =
                await identityRepository.findAdvisorByUserId(
                    user._id
                );

            if (!profile) {
                throw new AppError(
                    "Advisor profile unavailable.",
                    403,
                    "ADVISOR_PROFILE_REQUIRED"
                );
            }

            advisorId = String(profile._id);
        }

        req.auth = {
            userId: String(user._id),
            role: user.role,
            advisorId,
            name: user.name,
            email: user.email
        };

        req.user = req.auth;

        next();
    } catch (error) {
        next(error);
    }
}

export function requireActiveUser(req, res, next) {
    if (!req.auth?.userId) {
        return next(new AppError(
            "Authentication required.",
            401,
            "UNAUTHORIZED"
        ));
    }

    return next();
}

export default authenticate;