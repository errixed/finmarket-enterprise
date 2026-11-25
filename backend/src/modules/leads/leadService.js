import mongoose from "mongoose";

import Lead from "./models/Lead.js";
import repository from "./leadRepository.js";
import { identityRepository } from "../identity/identityRepository.js";
import { ROLES } from "../identity/identityConstants.js";
import AppError from "../../utils/AppError.js";

const editableFields = [
    "advisorId", "name", "email", "phone", "interest", "status",
    "marketingConsent", "source", "notes"
];
const statuses = Lead.schema.path("status").enumValues;
const sources = Lead.schema.path("source").enumValues;
const objectIdPattern = /^[a-f\d]{24}$/i;
const lifecycle = Object.freeze({
    NEW: "CONTACTED",
    CONTACTED: "CONSULTATION_REQUESTED",
    CONSULTATION_REQUESTED: "CONVERTED",
    CONVERTED: null
});

function fail(message, statusCode = 400, code = "INVALID_REQUEST") {
    throw new AppError(message, statusCode, code);
}

function assertAdvisor(actor) {
    if (!actor) fail("Authentication required.", 401, "UNAUTHORIZED");
    if (actor.role !== ROLES.ADVISOR || !objectIdPattern.test(actor.advisorId ?? "")) {
        fail("Only an authenticated advisor can manage private leads.", 403, "FORBIDDEN");
    }
    return actor.advisorId.toLowerCase();
}

function validateBody(input, partial = false) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        fail("Body must be a JSON object.");
    }

    const keys = Object.keys(input);
    if (partial && keys.length === 0) fail("Provide at least one field to update.");

    for (const key of keys) {
        if (!editableFields.includes(key)) fail(`Unsupported field: ${key}.`);
        if (key === "marketingConsent") {
            if (typeof input[key] !== "boolean") fail("marketingConsent must be a JSON boolean.");
        } else if (typeof input[key] !== "string") {
            fail(`${key} must be a string.`);
        }
    }

    if (input.advisorId !== undefined && !objectIdPattern.test(input.advisorId)) {
        fail("advisorId must be a 24-character ObjectId.");
    }
    if (input.status !== undefined && !statuses.includes(input.status)) {
        fail(`status must be one of: ${statuses.join(", ")}.`);
    }
    if (input.source !== undefined && !sources.includes(input.source)) {
        fail(`source must be one of: ${sources.join(", ")}.`);
    }
}

function validateListQuery(query) {
    const allowed = [
        "advisorId", "status", "marketingConsent", "source", "interest",
        "search", "page", "limit"
    ];

    for (const [key, value] of Object.entries(query)) {
        if (!allowed.includes(key)) fail(`Unsupported filter: ${key}.`);
        if (typeof value !== "string") fail(`${key} must be a single string value.`);
    }

    if (query.status && !statuses.includes(query.status)) fail("Invalid status filter.");
    if (query.source && !sources.includes(query.source)) fail("Invalid source filter.");
    if (query.advisorId && !objectIdPattern.test(query.advisorId)) fail("Invalid advisorId filter.");
    if (query.marketingConsent !== undefined && !["true", "false"].includes(query.marketingConsent)) {
        fail("marketingConsent filter must be true or false.");
    }

    const integer = (key, fallback, maximum) => {
        if (query[key] === undefined) return fallback;
        if (!/^[1-9]\d*$/.test(query[key])) fail(`${key} must be a positive integer.`);
        const value = Number(query[key]);
        if (!Number.isSafeInteger(value) || value > maximum) {
            fail(`${key} exceeds the allowed maximum ${maximum}.`);
        }
        return value;
    };

    return {
        page: integer("page", 1, 1000000),
        limit: integer("limit", 20, 100)
    };
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function requireOwnedAdvisor(actor, advisorId) {
    const advisor = await identityRepository.findAdvisorById(advisorId);
    if (!advisor) fail("Advisor profile not found.", 404, "NOT_FOUND");
    if (String(advisor.userId) !== String(actor.userId)) {
        fail("The advisor profile does not belong to the authenticated user.", 403, "FORBIDDEN");
    }
}

async function requireUniqueEmail(advisorId, email, excludeId = null) {
    const duplicate = await repository.findDuplicateContact(
        advisorId,
        email.trim().toLowerCase(),
        excludeId
    );

    if (duplicate) {
        fail("A lead with this email already exists for this advisor.", 409, "DUPLICATE_LEAD");
    }
}

function recordConsent(document, input, now, previouslyConsented = false) {
    if (input.marketingConsent === true) {
        if (!previouslyConsented || !document.consentRecordedAt) {
            document.consentRecordedAt = now;
        }
        document.unsubscribedAt = null;
    } else if (input.marketingConsent === false && previouslyConsented) {
        document.unsubscribedAt = now;
    }
}

async function findOwnedLead(id, advisorId) {
    if (!objectIdPattern.test(id ?? "")) {
        fail("Lead id must be a 24-character ObjectId.");
    }

    const lead = await repository.findById(id.toLowerCase(), advisorId);
    if (!lead) fail("Lead not found.", 404, "NOT_FOUND");
    return lead;
}

export async function createLead(input, actor) {
    const advisorId = assertAdvisor(actor);
    validateBody(input);

    if (input.advisorId && input.advisorId.toLowerCase() !== advisorId) {
        fail("A lead must belong to the authenticated advisor.", 403, "FORBIDDEN");
    }

    await requireOwnedAdvisor(actor, advisorId);
    const now = new Date();
    const document = new Lead({ ...input, advisorId, createdAt: now, updatedAt: now });
    recordConsent(document, input, now);

    const validationError = document.validateSync();
    if (validationError) {
        fail(Object.values(validationError.errors).map(item => item.message).join(" "));
    }

    await requireUniqueEmail(advisorId, document.email);
    return repository.create(document);
}

export async function getLead(id, actor) {
    const advisorId = assertAdvisor(actor);
    return findOwnedLead(id, advisorId);
}

export async function updateLead(id, input, actor) {
    const advisorId = assertAdvisor(actor);
    validateBody(input, true);

    const existing = await findOwnedLead(id, advisorId);
    if (input.advisorId !== undefined && input.advisorId.toLowerCase() !== advisorId) {
        fail("A lead cannot be reassigned to another advisor.", 403, "FORBIDDEN");
    }

    if (input.status && input.status !== existing.status && lifecycle[existing.status] !== input.status) {
        fail(`Invalid lifecycle transition from ${existing.status} to ${input.status}.`);
    }

    const now = new Date();
    const document = new Lead({ ...existing, ...input, advisorId, updatedAt: now });
    recordConsent(document, input, now, existing.marketingConsent);
    const validationError = document.validateSync();
    if (validationError) {
        fail(Object.values(validationError.errors).map(item => item.message).join(" "));
    }

    await requireUniqueEmail(advisorId, document.email, existing._id);
    const changes = {};
    for (const key of editableFields) {
        if (key !== "advisorId" && document[key] !== undefined) changes[key] = document[key];
    }
    changes.consentRecordedAt = document.consentRecordedAt;
    changes.unsubscribedAt = document.unsubscribedAt;

    const updated = await repository.update(existing._id, advisorId, changes);
    if (!updated) fail("Lead not found.", 404, "NOT_FOUND");
    return updated;
}

export async function listLeads(query, actor) {
    const advisorId = assertAdvisor(actor);
    const { page, limit } = validateListQuery(query);

    if (query.advisorId && query.advisorId.toLowerCase() !== advisorId) {
        fail("You cannot access another advisor's leads.", 403, "FORBIDDEN");
    }

    const filters = {};
    if (query.status) filters.status = query.status;
    if (query.source) filters.source = query.source;
    if (query.marketingConsent !== undefined) {
        filters.marketingConsent = query.marketingConsent === "true";
    }
    if (query.interest) filters.interest = new RegExp(escapeRegex(query.interest), "i");
    if (query.search) {
        const pattern = new RegExp(escapeRegex(query.search), "i");
        filters.$or = [{ name: pattern }, { email: pattern }];
    }

    return repository.findByAdvisor(advisorId, filters, { page, limit });
}

export async function findLeadForDelivery(leadId, advisorId) {
    if (!mongoose.isValidObjectId(leadId) || !mongoose.isValidObjectId(advisorId)) return null;
    return repository.findById(leadId, advisorId);
}

export async function findMarketingEligibleLeads(advisorId, filters = {}) {
    if (!mongoose.isValidObjectId(advisorId)) return [];
    const safeFilters = {};
    if (filters.interest) safeFilters.interest = filters.interest;
    if (filters.status) safeFilters.status = filters.status;
    return repository.findEligibleForMarketing(advisorId, safeFilters);
}
