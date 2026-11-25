import mongoose from "mongoose";
import jwt from "jsonwebtoken";

import config from "../../config.js";

import { identityRepository as repository } from "./identityRepository.js";

import {
    normalizeEmail,
    validateRegistration,
    validateProfile,
    validateAccountUpdate,
    validatePasswordChange,
    validId,
    fail
} from "./identityValidation.js";

import {
    hashPassword,
    verifyPassword
} from "./passwordService.js";

import { ROLES } from "./identityConstants.js";

function publicUser(user) {
    const data = user.toObject
        ? user.toObject()
        : { ...user };

    return {
        id: String(data._id),
        name: data.name,
        email: data.email,
        role: data.role,
        isActive: data.isActive,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt
    };
}

function publicAdvisor(profile) {
    const data = profile.toObject
        ? profile.toObject()
        : profile;

    const populatedUser =
        data.userId &&
            typeof data.userId === "object" &&
            data.userId.name
            ? data.userId
            : null;

    return {
        id: String(data._id),
        userId: populatedUser
            ? String(populatedUser._id)
            : String(data.userId),
        name: populatedUser?.name ?? null,
        specialties: data.specialties,
        consultationTypes: data.consultationTypes,
        bio: data.bio,
        isPublic: data.isPublic,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt
    };
}

function signToken(user) {
    return jwt.sign(
        {
            role: user.role,
            tokenVersion: user.tokenVersion ?? 0
        },
        config.JWT_SECRET,
        {
            algorithm: "HS256",
            subject: String(user._id),
            expiresIn: config.JWT_EXPIRES_IN,
            issuer: config.JWT_ISSUER,
            audience: config.JWT_AUDIENCE
        }
    );
}

export const identityService = {
    async updateOwnAccount(data, auth) {
        if (!auth?.userId) {
            fail(
                "Authentication required.",
                401,
                "UNAUTHORIZED"
            );
        }

        const input = validateAccountUpdate(data);

        const user = await repository.findUserById(
            auth.userId,
            true
        );

        if (!user || !user.isActive) {
            fail(
                "Account unavailable.",
                401,
                "UNAUTHORIZED"
            );
        }

        if (input.changes.email !== undefined) {
            const valid = await verifyPassword(
                input.currentPassword,
                user.passwordHash
            );

            if (!valid) {
                fail(
                    "Current password is incorrect.",
                    401,
                    "INVALID_CREDENTIALS"
                );
            }

            const existing = await repository.findUserByEmail(
                input.changes.email
            );

            if (
                existing &&
                String(existing._id) !== auth.userId
            ) {
                fail(
                    "Email already registered.",
                    409,
                    "DUPLICATE_EMAIL"
                );
            }
        }

        const updated = await repository.updateOwnAccount(
            auth.userId,
            input.changes,
            input.changes.email !== undefined
                ? user.passwordHash
                : undefined
        );

        if (!updated) {
            fail(
                "Account changed or is unavailable.",
                409,
                "ACCOUNT_UPDATE_CONFLICT"
            );
        }

        return {
            user: publicUser(updated),
            advisorId: auth.advisorId ?? null
        };
    },

    async changePassword(data, auth) {
        if (!auth?.userId) {
            fail(
                "Authentication required.",
                401,
                "UNAUTHORIZED"
            );
        }

        const input = validatePasswordChange(data);

        const user = await repository.findUserById(
            auth.userId,
            true
        );

        if (!user || !user.isActive) {
            fail(
                "Account unavailable.",
                401,
                "UNAUTHORIZED"
            );
        }

        const valid = await verifyPassword(
            input.currentPassword,
            user.passwordHash
        );

        if (!valid) {
            fail(
                "Current password is incorrect.",
                401,
                "INVALID_CREDENTIALS"
            );
        }

        const newHash = await hashPassword(
            input.newPassword
        );

        const updated = await repository.changePassword(
            auth.userId,
            user.passwordHash,
            newHash
        );

        if (!updated) {
            fail(
                "Password changed by another request.",
                409,
                "PASSWORD_UPDATE_CONFLICT"
            );
        }

        return {
            message: "Password changed successfully. Sign in again."
        };
    },
    async register(data = {}) {
        const input = validateRegistration(data);

        const existing = await repository.findUserByEmail(
            input.email
        );

        if (existing) {
            fail(
                "Email already registered.",
                409,
                "DUPLICATE_EMAIL"
            );
        }

        const passwordHash = await hashPassword(
            input.password
        );

        let user;
        let advisorProfile = null;

        await mongoose.connection.transaction(async session => {
            user = await repository.createUser({
                name: input.name,
                email: input.email,
                passwordHash,
                role: input.role,
                isActive: true
            }, session);

            if (input.role === ROLES.ADVISOR) {
                advisorProfile =
                    await repository.createAdvisorProfile({
                        userId: user._id,
                        specialties:
                            input.profile.specialties ?? [],
                        consultationTypes:
                            input.profile.consultationTypes ?? [],
                        bio: input.profile.bio ?? "",
                        isPublic:
                            input.profile.isPublic ?? false
                    }, session);
            }
        });

        return {
            user: publicUser(user),
            advisorProfile: advisorProfile
                ? {
                    ...publicAdvisor(advisorProfile),
                    name: user.name
                }
                : null
        };
    },

    async login(data = {}) {
        if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data) ||
            typeof data.email !== "string" ||
            typeof data.password !== "string" ||
            data.password.length === 0 ||
            Buffer.byteLength(data.password) > 1024
        ) {
            fail(
                "Valid email and password are required.",
                400
            );
        }

        const email = normalizeEmail(data.email);

        const user = await repository.findUserByEmail(
            email,
            true
        );

        if (!user) {
            fail(
                "Invalid email or password.",
                401,
                "INVALID_CREDENTIALS"
            );
        }

        const valid = await verifyPassword(
            data.password,
            user.passwordHash
        );

        if (!valid || !user.isActive) {
            fail(
                "Invalid email or password.",
                401,
                "INVALID_CREDENTIALS"
            );
        }

        return {
            user: publicUser(user),
            token: signToken(user),
            tokenType: "Bearer",
            expiresIn: config.JWT_EXPIRES_IN
        };
    },

    async getCurrentUser(auth) {
        const user = await repository.findUserById(
            auth.userId
        );

        if (!user || !user.isActive) {
            fail("Account unavailable.", 401, "UNAUTHORIZED");
        }

        return {
            user: publicUser(user),
            advisorId: auth.advisorId ?? null
        };
    },

    async listAdvisors() {
        const profiles =
            await repository.findAllPublicAdvisors();

        return profiles.map(publicAdvisor);
    },

    async getAdvisor(id) {
        const advisorId = validId(id, "Advisor ID");

        const profile =
            await repository.findPublicAdvisorById(advisorId);

        if (!profile) {
            fail(
                "Advisor not found.",
                404,
                "NOT_FOUND"
            );
        }

        return publicAdvisor(profile);
    },

    async updateAdvisorProfile(id, data, auth) {
        const advisorId = validId(id, "Advisor ID");

        if (
            auth.role !== ROLES.ADVISOR ||
            auth.advisorId !== advisorId
        ) {
            fail(
                "You cannot modify this advisor profile.",
                403,
                "FORBIDDEN"
            );
        }

        const changes = validateProfile(data, true);

        const profile =
            await repository.updateAdvisorProfile(
                advisorId,
                changes
            );

        if (!profile) {
            fail(
                "Advisor not found.",
                404,
                "NOT_FOUND"
            );
        }

        return {
            ...publicAdvisor(profile),
            name: auth.name
        };
    }
};