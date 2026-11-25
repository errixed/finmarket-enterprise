import mongoose from "mongoose";
import AppError from "../../utils/AppError.js";
import {
    TRIGGERS,
    ACTIONS,
    DELIVERY_ACTIONS,
    EVENT_TYPES,
    ENTITY_TYPES,
    ENTITY_TYPE_ALIASES,
    EVENT_ENTITY_TYPE,
    EVENT_SOURCES,
    PROCESSING_STATUSES,
    EXECUTION_STATUSES,
    TRIGGER_ACTION_COMPATIBILITY,
    DELAY_MINUTES_MAX,
    PAGINATION
} from "./automationConstants.js";

// All validation for the module lives here. Every function either returns
// clean data or throws an AppError (status 400 unless stated otherwise), so
// controllers and services never see untrusted input.

export function validationError(problems) {
    const list = Array.isArray(problems) ? problems : [problems];
    return new AppError(list.join(" "), 400, "VALIDATION_ERROR");
}

export const isObjectIdString = (value) =>
    typeof value === "string" &&
    /^[a-f0-9]{24}$/i.test(value) &&
    mongoose.isValidObjectId(value);

const oneOf = (list) => `must be one of: ${list.join(", ")}.`;

const isPlainObject = (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null);

function requireBodyObject(body) {
    if (!isPlainObject(body)) {
        throw validationError("Request body must be a JSON object.");
    }
}

// Fields that only the server may write. Naming them gives a clearer error
// than "unknown field" and documents the mass-assignment protection.
const PROTECTED_FIELDS = new Set([
    "_id",
    "id",
    "__v",
    "createdAt",
    "updatedAt",
    "lastExecutedAt",
    "executionCount",
    "processingStatus",
    "processingStartedAt",
    "processedAt",
    "processingError",
    "matchedRuleCount",
    "source",
    "status"
]);

function rejectUnexpectedFields(body, allowed, problems) {
    for (const key of Object.keys(body)) {
        if (allowed.has(key)) continue;

        problems.push(
            PROTECTED_FIELDS.has(key)
                ? `${key} cannot be set by clients.`
                : `${key} is not a supported field.`
        );
    }
}

// ---------------------------------------------------------------------------
// Automation rules
// ---------------------------------------------------------------------------

const RULE_CREATE_FIELDS = new Set([
    "ownerId",
    "name",
    "description",
    "trigger",
    "action",
    "campaignId",
    "delayMinutes",
    "enabled",
    "actionConfig",
    "allowSpecialistToggle"
]);

// ownerId is deliberately absent: ownership can never be changed.
const RULE_UPDATE_FIELDS = new Set([
    "name",
    "description",
    "trigger",
    "action",
    "campaignId",
    "delayMinutes",
    "enabled",
    "actionConfig",
    "allowSpecialistToggle"
]);

function checkRuleFields(input, problems) {
    if (input.name !== undefined) {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (name.length < 3 || name.length > 150) {
            problems.push("name must be 3 to 150 characters.");
        }
    }

    if (input.description !== undefined) {
        if (typeof input.description !== "string" || input.description.length > 1000) {
            problems.push("description must be text up to 1000 characters.");
        }
    }

    if (input.trigger !== undefined && !TRIGGERS.includes(input.trigger)) {
        problems.push(`trigger ${oneOf(TRIGGERS)}`);
    }

    if (input.action !== undefined && !ACTIONS.includes(input.action)) {
        problems.push(`action ${oneOf(ACTIONS)}`);
    }

    if (
        input.campaignId !== undefined &&
        input.campaignId !== null &&
        !isObjectIdString(input.campaignId)
    ) {
        problems.push("campaignId must be a valid id or null.");
    }

    if (input.delayMinutes !== undefined) {
        if (
            !Number.isInteger(input.delayMinutes) ||
            input.delayMinutes < 0 ||
            input.delayMinutes > DELAY_MINUTES_MAX
        ) {
            problems.push(
                `delayMinutes must be a whole number from 0 to ${DELAY_MINUTES_MAX}.`
            );
        }
    }

    for (const flag of ["enabled", "allowSpecialistToggle"]) {
        if (input[flag] !== undefined && typeof input[flag] !== "boolean") {
            problems.push(`${flag} must be true or false.`);
        }
    }

    if (input.actionConfig !== undefined) {
        const config = input.actionConfig;

        if (!isPlainObject(config)) {
            problems.push("actionConfig must be an object.");
        } else {
            for (const key of Object.keys(config)) {
                if (!["subject", "body"].includes(key)) {
                    problems.push(`actionConfig.${key} is not a supported field.`);
                }
            }
            if (
                config.subject !== undefined &&
                (typeof config.subject !== "string" || config.subject.length > 200)
            ) {
                problems.push("actionConfig.subject must be text up to 200 characters.");
            }
            if (
                config.body !== undefined &&
                (typeof config.body !== "string" || config.body.length > 10000)
            ) {
                problems.push("actionConfig.body must be text up to 10000 characters.");
            }
        }
    }
}

// Rules that are valid on their own can still be an unsafe combination.
// Called on the final (merged) rule for both create and update.
export function assertRuleConsistency(rule) {
    const problems = [];

    if (!TRIGGER_ACTION_COMPATIBILITY[rule.trigger]?.includes(rule.action)) {
        problems.push(
            `Trigger ${rule.trigger} cannot be combined with action ${rule.action}. ` +
            `Allowed actions: ${(TRIGGER_ACTION_COMPATIBILITY[rule.trigger] ?? []).join(", ")}.`
        );
    }

    // A draft (disabled) rule may omit the campaign; a live delivery rule
    // may not, because a DeliveryJob always belongs to a campaign.
    if (
        rule.enabled === true &&
        DELIVERY_ACTIONS.includes(rule.action) &&
        !rule.campaignId
    ) {
        problems.push(
            `campaignId is required to enable a rule with action ${rule.action}.`
        );
    }

    if (problems.length) throw validationError(problems);
}

export function parseRuleCreate(body) {
    requireBodyObject(body);

    const problems = [];
    rejectUnexpectedFields(body, RULE_CREATE_FIELDS, problems);

    if (body.ownerId !== undefined && !isObjectIdString(body.ownerId)) {
        problems.push("ownerId must be a valid id.");
    }
    if (body.name === undefined) problems.push("name is required.");
    if (body.trigger === undefined) problems.push("trigger is required.");
    if (body.action === undefined) problems.push("action is required.");

    checkRuleFields(body, problems);

    if (problems.length) throw validationError(problems);

    return {
        // Compared with the authenticated user by the service; never stored.
        claimedOwnerId: body.ownerId?.toLowerCase(),
        data: {
            name: body.name.trim(),
            description: body.description?.trim() ?? "",
            trigger: body.trigger,
            action: body.action,
            campaignId: body.campaignId?.toLowerCase() ?? null,
            delayMinutes: body.delayMinutes ?? 0,
            enabled: body.enabled ?? false,
            actionConfig: {
                subject: body.actionConfig?.subject?.trim() ?? "",
                body: body.actionConfig?.body?.trim() ?? ""
            },
            allowSpecialistToggle: body.allowSpecialistToggle ?? false
        }
    };
}

export function parseRuleUpdate(body) {
    requireBodyObject(body);

    const problems = [];
    // ownerId is allowed through this check only so it gets its own message.
    rejectUnexpectedFields(
        body,
        new Set([...RULE_UPDATE_FIELDS, "ownerId"]),
        problems
    );

    if (body.ownerId !== undefined) {
        problems.push("ownerId cannot be changed.");
    }

    if (Object.keys(body).length === 0) {
        problems.push("At least one field to update is required.");
    }

    checkRuleFields(body, problems);

    if (problems.length) throw validationError(problems);

    const changes = {};

    for (const key of Object.keys(body)) {
        const value = body[key];

        if (key === "name" || key === "description") changes[key] = value.trim();
        else if (key === "campaignId") changes[key] = value?.toLowerCase() ?? null;
        else if (key === "actionConfig") {
            changes.actionConfig = {
                subject: value.subject?.trim() ?? "",
                body: value.body?.trim() ?? ""
            };
        } else changes[key] = value;
    }

    return changes;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENT_SIMULATION_FIELDS = new Set([
    "eventId",
    "eventType",
    "entityType",
    "entityId",
    "ownerId",
    "metadata"
]);

// Trusted (internal) events may also carry the original occurrence time.
const EVENT_INTERNAL_FIELDS = new Set([...EVENT_SIMULATION_FIELDS, "occurredAt"]);

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

// Metadata must never carry credentials or personal contact data.
const BLOCKED_KEY_FRAGMENTS = [
    "password",
    "passwd",
    "secret",
    "token",
    "jwt",
    "authorization",
    "credential",
    "apikey",
    "privatekey",
    "ssn",
    "creditcard",
    "cardnumber",
    "cvv",
    "iban",
    "accountnumber",
    "email",
    "phone",
    "address"
];

const JWT_LIKE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const METADATA_LIMITS = Object.freeze({
    maxBytes: 4096,
    maxDepth: 3,
    maxKeys: 50,
    maxArray: 50,
    maxString: 500
});

const normalizeKey = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

const isBlockedKey = (key) => {
    const normalized = normalizeKey(key);
    return BLOCKED_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
};

const isUnsafeKeyName = (key) =>
    key.startsWith("$") || key.includes(".") || key === "__proto__" ||
    key === "constructor" || key === "prototype";

// Rejects unsafe metadata. Only the path is reported, never the value.
export function sanitizeMetadata(metadata) {
    if (metadata === undefined) return {};

    if (!isPlainObject(metadata)) {
        throw validationError("metadata must be an object.");
    }

    const problems = [];
    let keyCount = 0;

    const visit = (value, path, depth) => {
        if (depth > METADATA_LIMITS.maxDepth) {
            problems.push(`metadata is nested too deeply at ${path}.`);
            return;
        }

        if (Array.isArray(value)) {
            if (value.length > METADATA_LIMITS.maxArray) {
                problems.push(`metadata array ${path} is too long.`);
                return;
            }
            value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
            return;
        }

        if (isPlainObject(value)) {
            for (const [key, child] of Object.entries(value)) {
                keyCount += 1;
                const childPath = path ? `${path}.${key}` : key;

                if (keyCount > METADATA_LIMITS.maxKeys) {
                    problems.push("metadata has too many fields.");
                    return;
                }
                if (isUnsafeKeyName(key)) {
                    problems.push(`metadata field ${childPath} has an unsafe name.`);
                    continue;
                }
                if (isBlockedKey(key)) {
                    problems.push(`metadata field ${childPath} may contain sensitive data and is not allowed.`);
                    continue;
                }
                visit(child, childPath, depth + 1);
            }
            return;
        }

        if (typeof value === "string") {
            if (value.length > METADATA_LIMITS.maxString) {
                problems.push(`metadata value at ${path} is too long.`);
            } else if (JWT_LIKE.test(value) || /^Bearer\s/i.test(value)) {
                problems.push(`metadata value at ${path} looks like a credential.`);
            } else if (EMAIL_LIKE.test(value)) {
                problems.push(`metadata value at ${path} looks like contact information.`);
            }
            return;
        }

        if (
            value !== null &&
            typeof value !== "number" &&
            typeof value !== "boolean"
        ) {
            problems.push(`metadata value at ${path} has an unsupported type.`);
        }
    };

    visit(metadata, "", 0);

    if (
        problems.length === 0 &&
        Buffer.byteLength(JSON.stringify(metadata)) > METADATA_LIMITS.maxBytes
    ) {
        problems.push(`metadata must be smaller than ${METADATA_LIMITS.maxBytes} bytes.`);
    }

    if (problems.length) {
        throw new AppError(problems.join(" "), 400, "METADATA_NOT_ALLOWED");
    }

    return structuredClone(metadata);
}

// Defence in depth for reads: removes anything sensitive instead of throwing.
export function redactMetadata(metadata) {
    if (Array.isArray(metadata)) return metadata.map(redactMetadata);

    if (metadata && typeof metadata === "object") {
        return Object.fromEntries(
            Object.entries(metadata)
                .filter(([key]) => !isBlockedKey(key) && !isUnsafeKeyName(key))
                .map(([key, value]) => [key, redactMetadata(value)])
        );
    }

    return metadata;
}

// Parses one event. `mode` is "simulation" (client input) or "internal"
// (trusted backend operation). Returns a clean event or throws.
export function parseEvent(body, { mode, defaults = {} } = {}) {
    requireBodyObject(body);

    const allowed = mode === "internal" ? EVENT_INTERNAL_FIELDS : EVENT_SIMULATION_FIELDS;
    const problems = [];
    rejectUnexpectedFields(body, allowed, problems);

    const merged = { ...defaults, ...body };

    const eventType = merged.eventType;
    // Only events that can trigger rules are accepted from outside. The
    // AUTOMATION_* audit events are written by this module alone.
    if (!TRIGGERS.includes(eventType)) {
        problems.push(`eventType ${oneOf(TRIGGERS)}`);
    }

    let entityType = merged.entityType ?? EVENT_ENTITY_TYPE[eventType];
    entityType = ENTITY_TYPE_ALIASES[entityType] ?? entityType;

    if (!ENTITY_TYPES.includes(entityType)) {
        problems.push(`entityType ${oneOf([...ENTITY_TYPES, ...Object.keys(ENTITY_TYPE_ALIASES)])}`);
    } else if (
        TRIGGERS.includes(eventType) &&
        EVENT_ENTITY_TYPE[eventType] !== entityType
    ) {
        problems.push(
            `entityType ${entityType} does not match eventType ${eventType} ` +
            `(expected ${EVENT_ENTITY_TYPE[eventType]}).`
        );
    }

    if (!isObjectIdString(merged.entityId)) {
        problems.push("entityId must be a valid id.");
    }
    if (!isObjectIdString(merged.ownerId)) {
        problems.push("ownerId must be a valid id.");
    }

    if (
        typeof merged.eventId !== "string" ||
        !EVENT_ID_PATTERN.test(merged.eventId)
    ) {
        problems.push(
            "eventId must be 1 to 100 characters: letters, numbers, dot, colon, underscore or hyphen."
        );
    }

    let occurredAt;
    if (merged.occurredAt !== undefined) {
        occurredAt = new Date(merged.occurredAt);
        if (Number.isNaN(occurredAt.getTime())) {
            problems.push("occurredAt must be a valid date.");
        } else if (occurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
            problems.push("occurredAt cannot be in the future.");
        }
    }

    if (problems.length) throw validationError(problems);

    const metadata = sanitizeMetadata(merged.metadata);

    // campaignId is derived by the server so clients cannot attach an event
    // to a campaign they do not own: for campaign events it is the entity,
    // otherwise it may be supplied in metadata and is verified later.
    const campaignId =
        entityType === "CAMPAIGN"
            ? merged.entityId.toLowerCase()
            : isObjectIdString(metadata.campaignId)
                ? metadata.campaignId.toLowerCase()
                : null;

    if (
        entityType !== "CAMPAIGN" &&
        metadata.campaignId !== undefined &&
        !isObjectIdString(metadata.campaignId)
    ) {
        throw validationError("metadata.campaignId must be a valid id.");
    }

    return {
        eventId: merged.eventId,
        eventType,
        entityType,
        entityId: merged.entityId.toLowerCase(),
        ownerId: merged.ownerId.toLowerCase(),
        campaignId,
        metadata,
        ...(occurredAt ? { occurredAt } : {})
    };
}

// ---------------------------------------------------------------------------
// List queries (rules, events, executions)
// ---------------------------------------------------------------------------

const QUERY_SPECS = {
    rules: {
        ownerId: "id",
        campaignId: "id",
        trigger: TRIGGERS,
        action: ACTIONS,
        enabled: "boolean"
    },
    events: {
        ownerId: "id",
        campaignId: "id",
        entityId: "id",
        eventType: EVENT_TYPES,
        entityType: ENTITY_TYPES,
        processingStatus: PROCESSING_STATUSES,
        source: EVENT_SOURCES,
        from: "date",
        to: "date"
    },
    executions: {
        ownerId: "id",
        campaignId: "id",
        automationRuleId: "id",
        eventId: "text",
        status: EXECUTION_STATUSES,
        action: ACTIONS,
        simulated: "boolean",
        from: "date",
        to: "date"
    }
};

// Turns the raw query string into a clean filter plus pagination. Anything
// that is not a plain string (repeated or nested parameters) is rejected,
// which also blocks query-operator injection.
export function parseListQuery(query = {}, kind) {
    const spec = QUERY_SPECS[kind];
    const problems = [];
    const filters = {};
    const pagination = { page: 1, limit: PAGINATION.defaultLimit };

    for (const [key, raw] of Object.entries(query)) {
        if (typeof raw !== "string") {
            problems.push(`${key} must be a single value.`);
            continue;
        }

        if (key === "page" || key === "limit") {
            const number = Number(raw);
            const max = key === "limit" ? PAGINATION.maxLimit : 1_000_000;

            if (!/^\d+$/.test(raw) || number < 1 || number > max) {
                problems.push(`${key} must be a whole number from 1 to ${max}.`);
            } else {
                pagination[key] = number;
            }
            continue;
        }

        const rule = spec[key];

        if (rule === undefined) {
            problems.push(`${key} is not a supported filter.`);
        } else if (rule === "id") {
            if (isObjectIdString(raw)) filters[key] = raw.toLowerCase();
            else problems.push(`${key} must be a valid id.`);
        } else if (rule === "boolean") {
            if (raw === "true" || raw === "false") filters[key] = raw === "true";
            else problems.push(`${key} must be true or false.`);
        } else if (rule === "date") {
            const date = new Date(raw);
            if (Number.isNaN(date.getTime())) problems.push(`${key} must be a valid date.`);
            else filters[key] = date;
        } else if (rule === "text") {
            if (EVENT_ID_PATTERN.test(raw)) filters[key] = raw;
            else problems.push(`${key} is not a valid event id.`);
        } else if (rule.includes(raw)) {
            filters[key] = raw;
        } else {
            problems.push(`${key} ${oneOf(rule)}`);
        }
    }

    if (filters.from && filters.to && filters.from > filters.to) {
        problems.push("from must not be later than to.");
    }

    if (problems.length) throw validationError(problems);

    return { filters, ...pagination };
}
