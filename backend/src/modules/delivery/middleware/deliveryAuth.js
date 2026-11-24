import crypto from "node:crypto";
import mongoose from "mongoose";
import * as sharedAuth from "../../../middleware/authMiddleware.js";
import * as sharedRole from "../../../middleware/roleMiddleware.js";
import User from "../../identity/models/User.js";
import AdvisorProfile from "../../identity/models/AdvisorProfile.js";
import AppError from "../../../utils/AppError.js";

const decodeBase64UrlJson = (segment) => {
    const decoded = Buffer.from(segment, "base64url").toString("utf8");
    return JSON.parse(decoded);
};

const verifyHs256Token = (token, secret) => {
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new Error("Malformed token.");
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    const header = decodeBase64UrlJson(headerB64);

    if (!header || header.alg !== "HS256") {
        throw new Error("Unsupported algorithm.");
    }

    const expectedSig = crypto
        .createHmac("sha256", secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest();
    const actualSig = Buffer.from(signatureB64, "base64url");

    if (
        expectedSig.length !== actualSig.length ||
        !crypto.timingSafeEqual(expectedSig, actualSig)
    ) {
        throw new Error("Invalid signature.");
    }

    const payload = decodeBase64UrlJson(payloadB64);

    if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload.");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp <= nowSeconds) {
        throw new Error("Token expired.");
    }

    if (typeof payload.nbf === "number" && payload.nbf > nowSeconds) {
        throw new Error("Token not active yet.");
    }

    return payload;
};

export const authenticateDelivery = async (req, res, next) => {
    if (typeof sharedAuth.authenticate === "function") {
        return sharedAuth.authenticate(req, res, next);
    }

    try {
        const authorization = req.headers.authorization;

        if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
            throw new AppError(
                "Authentication required.",
                401,
                "UNAUTHORIZED"
            );
        }

        const secret = process.env.JWT_SECRET;
        if (!secret) {
            throw new AppError(
                "JWT authentication is not configured.",
                500,
                "AUTH_CONFIG_ERROR"
            );
        }

        const token = authorization.replace(/^Bearer /i, "").trim();

        let payload;
        try {
            payload = verifyHs256Token(token, secret);
        } catch {
            throw new AppError(
                "Invalid or expired authentication token.",
                401,
                "INVALID_TOKEN"
            );
        }

        if (!payload.sub || !/^[a-f0-9]{24}$/i.test(String(payload.sub))) {
            throw new AppError(
                "Invalid authentication token.",
                401,
                "INVALID_TOKEN"
            );
        }

        if (mongoose.connection.readyState !== 1) {
            throw new AppError(
                "Authentication service unavailable.",
                503,
                "AUTH_UNAVAILABLE"
            );
        }

        const user = await User.findById(payload.sub).lean();

        if (!user || !user.isActive) {
            throw new AppError(
                "Account unavailable.",
                401,
                "UNAUTHORIZED"
            );
        }

        let advisorId = null;

        if (user.role === "ADVISOR") {
            const profile = await AdvisorProfile.findOne({
                userId: user._id
            }).lean();

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
        return next();
    } catch (error) {
        return next(error);
    }
};

export const authorizeDeliveryRoles = (...allowedRoles) => {
    if (typeof sharedRole.authorizeRoles === "function") {
        return sharedRole.authorizeRoles(...allowedRoles);
    }

    return (req, res, next) => {
        if (!req.auth) {
            return next(
                new AppError("Authentication required.", 401, "UNAUTHORIZED")
            );
        }

        if (!allowedRoles.includes(req.auth.role)) {
            return next(
                new AppError(
                    "You do not have permission to perform this action.",
                    403,
                    "FORBIDDEN"
                )
            );
        }

        return next();
    };
};