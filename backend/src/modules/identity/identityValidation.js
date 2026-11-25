import mongoose from "mongoose";
import AppError from "../../utils/AppError.js";
import {
    CONSULTATION_TYPES,
    PUBLIC_REGISTRATION_ROLES
} from "./identityConstants.js";

export function fail(message, status = 400, code = "INVALID_REQUEST") {
    throw new AppError(message, status, code);
}

export function requireObject(value, label = "Request body") {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
    ) {
        fail(`${label} must be an object.`);
    }

    return value;
}

export function allowOnly(data, fields) {
    for (const key of Object.keys(data)) {
        if (!fields.includes(key)) {
            fail(`Unsupported field: ${key}.`);
        }
    }
}

export function validId(value, label = "ID") {
    if (
        typeof value !== "string" ||
        !/^[a-f0-9]{24}$/i.test(value) ||
        !mongoose.isValidObjectId(value)
    ) {
        fail(`${label} must be a valid ObjectId.`);
    }

    return value.toLowerCase();
}

export function normalizeEmail(value) {
    if (typeof value !== "string") {
        fail("Invalid email address.");
    }

    const email = value.trim().toLowerCase();

    if (
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
        fail("Invalid email address.");
    }

    return email;
}

export function validateProfile(data = {}, partial = false) {
    requireObject(data, "Profile");

    allowOnly(data, [
        "specialties",
        "consultationTypes",
        "bio",
        "isPublic"
    ]);

    if (partial && Object.keys(data).length === 0) {
        fail("Provide at least one field to update.");
    }

    const result = {};

    if (data.specialties !== undefined) {
        if (
            !Array.isArray(data.specialties) ||
            !data.specialties.every(item =>
                typeof item === "string" &&
                item.trim().length > 0
            )
        ) {
            fail("Invalid specialties.");
        }

        result.specialties = [
            ...new Set(
                data.specialties.map(item => item.trim())
            )
        ];
    }

    if (data.consultationTypes !== undefined) {
        if (
            !Array.isArray(data.consultationTypes) ||
            !data.consultationTypes.every(type =>
                CONSULTATION_TYPES.includes(type)
            )
        ) {
            fail("Invalid consultation types.");
        }

        result.consultationTypes = [
            ...new Set(data.consultationTypes)
        ];
    }

    if (data.bio !== undefined) {
        if (
            typeof data.bio !== "string" ||
            data.bio.length > 1000
        ) {
            fail("Invalid biography.");
        }

        result.bio = data.bio.trim();
    }

    if (data.isPublic !== undefined) {
        if (typeof data.isPublic !== "boolean") {
            fail("isPublic must be a boolean.");
        }

        result.isPublic = data.isPublic;
    }

    return result;
}

export function validateRegistration(data) {
    requireObject(data);

    allowOnly(data, [
        "name",
        "email",
        "password",
        "role",
        "profile"
    ]);

    if (
        typeof data.name !== "string" ||
        data.name.trim().length < 2 ||
        data.name.trim().length > 100
    ) {
        fail("Name must contain 2 to 100 characters.");
    }

    if (
        typeof data.password !== "string" ||
        data.password.length < 8 ||
        Buffer.byteLength(data.password) > 1024
    ) {
        fail("Password must contain at least 8 characters.");
    }

    if (!PUBLIC_REGISTRATION_ROLES.includes(data.role)) {
        fail("Invalid registration role.");
    }

    if (
        data.role !== "ADVISOR" &&
        data.profile !== undefined
    ) {
        fail("Only advisors can create advisor profiles.");
    }

    return {
        name: data.name.trim(),
        email: normalizeEmail(data.email),
        password: data.password,
        role: data.role,
        profile: data.role === "ADVISOR"
            ? validateProfile(data.profile ?? {})
            : null
    };
}
export function validateAccountUpdate(data) {
    requireObject(data);

    allowOnly(data, [
        "name",
        "email",
        "currentPassword"
    ]);

    const changes = {};

    if (data.name !== undefined) {
        if (
            typeof data.name !== "string" ||
            data.name.trim().length < 2 ||
            data.name.trim().length > 100
        ) {
            fail("Name must contain 2 to 100 characters.");
        }

        changes.name = data.name.trim();
    }

    if (data.email !== undefined) {
        changes.email = normalizeEmail(data.email);

        if (
            typeof data.currentPassword !== "string" ||
            data.currentPassword.length === 0 ||
            Buffer.byteLength(data.currentPassword) > 1024
        ) {
            fail("Current password is required to change email.");
        }
    }

    if (Object.keys(changes).length === 0) {
        fail("At least one account field must be supplied.");
    }

    return {
        changes,
        currentPassword: data.currentPassword
    };
}

export function validatePasswordChange(data) {
    requireObject(data);

    allowOnly(data, [
        "currentPassword",
        "newPassword"
    ]);

    if (
        typeof data.currentPassword !== "string" ||
        data.currentPassword.length === 0 ||
        Buffer.byteLength(data.currentPassword) > 1024
    ) {
        fail("Current password is required.");
    }

    if (
        typeof data.newPassword !== "string" ||
        data.newPassword.length < 8 ||
        Buffer.byteLength(data.newPassword) > 1024
    ) {
        fail("New password must contain at least 8 characters.");
    }

    if (data.currentPassword === data.newPassword) {
        fail("New password must differ from the current password.");
    }

    return {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword
    };
}