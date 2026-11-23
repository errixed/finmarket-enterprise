import mongoose from "mongoose";
import express from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import errorHandler from "../../../src/middleware/errorHandler.js";
import notFoundMiddleware from "../../../src/middleware/notFoundMiddleware.js";
import AppError from "../../../src/utils/AppError.js";

import User from "../../../src/modules/identity/models/User.js";
import AdvisorProfile from "../../../src/modules/identity/models/AdvisorProfile.js";
import AdvisorSpecialistAssignment from "../../../src/modules/identity/models/AdvisorSpecialistAssignment.js";
import Campaign from "../../../src/modules/campaigns/models/Campaign.js";
import Lead from "../../../src/modules/leads/models/Lead.js";
import DeliveryJob from "../../../src/modules/delivery/models/DeliveryJob.js";

import AutomationRule from "../../../src/modules/automation/models/AutomationRule.js";
import ActivityEvent from "../../../src/modules/automation/models/ActivityEvent.js";
import AutomationExecution from "../../../src/modules/automation/models/AutomationExecution.js";

import createAutomationService from "../../../src/modules/automation/automationService.js";
import { createAutomationRouter } from "../../../src/modules/automation/automationRoutes.js";
import { createAnalyticsRouter } from "../../../src/modules/automation/analyticsRoutes.js";
import { createDefaultAdapters } from "../../../src/modules/automation/automationAdapters.js";
import createExecutionService from "../../../src/modules/automation/automationExecutionService.js";
import automationRepository from "../../../src/modules/automation/automationRepository.js";

export {
    User,
    AdvisorProfile,
    AdvisorSpecialistAssignment,
    Campaign,
    Lead,
    DeliveryJob,
    AutomationRule,
    ActivityEvent,
    AutomationExecution
};

// ---------------------------------------------------------------------------
// Test database (real MongoDB; the Dockerized replica set or any mongod)
// ---------------------------------------------------------------------------

let activeUri = null;

function buildTestUri(suiteName) {
    const original = process.env.MONGO_URI;

    if (!original) {
        throw new Error(
            "MONGO_URI is required for the automation tests, for example: " +
            "mongodb://127.0.0.1:27017/finmarket_test?replicaSet=rs0"
        );
    }

    const uri = new URL(original);
    const databaseName = uri.pathname.replace(/^\//, "");

    // Safety: the suite drops its database afterwards.
    if (!databaseName.includes("_test")) {
        throw new Error("Tests require a database containing _test in its name.");
    }

    const safeName = suiteName.replace(/[^a-zA-Z0-9_]/g, "_");
    const unique = randomUUID().replaceAll("-", "").slice(0, 10);

    uri.pathname = `/${databaseName}_${safeName}_${unique}`;

    return uri.toString();
}

export async function connectTestDatabase(suiteName) {
    if (mongoose.connection.readyState !== 0) {
        throw new Error("A Mongoose connection is already active.");
    }

    activeUri = buildTestUri(suiteName);

    await mongoose.connect(activeUri, { serverSelectionTimeoutMS: 15000 });

    // Build the indexes (including the unique ones) before any test runs.
    await Promise.all(
        [AutomationRule, ActivityEvent, AutomationExecution, User, AdvisorProfile]
            .map((model) => model.init())
    );

    return mongoose.connection;
}

// Simulates a backend restart: drops the connection and reconnects to the
// same database. Nothing in memory survives; only MongoDB does.
export async function restartDatabaseConnection() {
    await mongoose.disconnect();
    await mongoose.connect(activeUri, { serverSelectionTimeoutMS: 15000 });
}

export async function disconnectTestDatabase() {
    try {
        if (mongoose.connection.readyState === 1) {
            if (!mongoose.connection.name.includes("_test")) {
                throw new Error("Refusing to delete a non-test database.");
            }

            await mongoose.connection.dropDatabase();
        }
    } finally {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    }
}

export async function clearAutomationData() {
    await Promise.all([
        AutomationRule.deleteMany({}),
        ActivityEvent.deleteMany({}),
        AutomationExecution.deleteMany({})
    ]);
}

// ---------------------------------------------------------------------------
// Stand-in for Member 1's shared `authenticate` middleware.
//
// The real middleware (feature/identity-p2-m1) verifies a Bearer JWT and
// puts { userId, role, advisorId } on req.auth and req.user. This stand-in
// follows the same contract with a local HS256 secret so the Automation
// module can be tested in isolation, as the Phase II guide allows
// (section 2.1, item 5). It is only used by tests.
// ---------------------------------------------------------------------------

export const TEST_JWT_SECRET = "automation-test-secret-automation-test-secret";

const base64url = (value) =>
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

export function signToken(
    { userId, role, advisorId = null },
    { secret = TEST_JWT_SECRET, expiresInSeconds = 3600 } = {}
) {
    const header = base64url({ alg: "HS256", typ: "JWT" });
    const body = base64url({
        sub: userId,
        role,
        advisorId,
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds
    });
    const signature = createHmac("sha256", secret)
        .update(`${header}.${body}`)
        .digest("base64url");

    return `${header}.${body}.${signature}`;
}

export function testAuthenticate(req, res, next) {
    const authorization = req.headers.authorization;

    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
        return next(new AppError("Authentication required.", 401, "UNAUTHORIZED"));
    }

    const parts = authorization.replace(/^Bearer /i, "").split(".");
    const invalid = () =>
        next(new AppError("Invalid or expired authentication token.", 401, "INVALID_TOKEN"));

    if (parts.length !== 3) return invalid();

    const expected = createHmac("sha256", TEST_JWT_SECRET)
        .update(`${parts[0]}.${parts[1]}`)
        .digest();
    const actual = Buffer.from(parts[2], "base64url");

    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return invalid();
    }

    let payload;

    try {
        payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    } catch {
        return invalid();
    }

    if (!payload.exp || payload.exp * 1000 < Date.now()) return invalid();

    req.auth = { userId: payload.sub, role: payload.role, advisorId: payload.advisorId };
    req.user = req.auth;

    return next();
}

// ---------------------------------------------------------------------------
// Application under test
// ---------------------------------------------------------------------------

// Records every request Automation sends to Delivery. `behavior` decides the
// answer: a function (request, callNumber) that returns or throws.
export function createMockDelivery(behavior) {
    const calls = [];

    return {
        calls,
        async requestDelivery(request) {
            calls.push(structuredClone(request));

            if (behavior) return behavior(request, calls.length);

            return { deliveryJobId: new mongoose.Types.ObjectId().toString(), status: "PENDING" };
        }
    };
}

export const deliveryError = (statusCode, code, extra = {}) =>
    Object.assign(new Error(`Delivery error ${code}`), { statusCode, code, ...extra });

export function createTestContext({
    delivery = createMockDelivery(),
    adapters: adapterOverrides = {},
    clock,
    env = { NODE_ENV: "test" }
} = {}) {
    const adapters = { ...createDefaultAdapters(), delivery, ...adapterOverrides };
    const service = createAutomationService({
        repository: automationRepository,
        adapters,
        clock,
        env
    });

    const app = express();

    app.use(express.json());
    app.use("/api/v1/automations", createAutomationRouter({ service, authenticate: testAuthenticate }));
    app.use("/api/v1/analytics", createAnalyticsRouter({ service, authenticate: testAuthenticate }));
    app.use(notFoundMiddleware);
    app.use(errorHandler);

    return { app, service, adapters, delivery };
}

// A second execution service on the same database, standing in for another
// backend instance or a restarted process.
export function createWorkerService({ delivery, clock, workerId } = {}) {
    return createExecutionService({
        repository: automationRepository,
        adapters: { ...createDefaultAdapters(), delivery: delivery ?? createMockDelivery() },
        clock,
        workerId
    });
}

export async function startServer(app) {
    const server = app.listen(0);

    await new Promise((resolve) => server.once("listening", resolve));

    const base = `http://127.0.0.1:${server.address().port}/api/v1`;

    return {
        base,
        close: () => new Promise((resolve) => server.close(resolve)),
        async request(method, path, { token, body, headers = {} } = {}) {
            const response = await fetch(base + path, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...headers
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const json = await response.json().catch(() => null);

            return { status: response.status, body: json };
        }
    };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const newId = () => new mongoose.Types.ObjectId();

export async function createAdvisor(label = "Advisor") {
    const user = await User.create({
        name: `${label} ${randomUUID().slice(0, 6)}`,
        email: `${randomUUID()}@example.com`,
        passwordHash: "not-a-real-hash",
        role: "ADVISOR"
    });
    const profile = await AdvisorProfile.create({ userId: user._id });
    const userId = String(user._id);
    const advisorId = String(profile._id);

    return {
        user,
        userId,
        advisorId,
        token: signToken({ userId, role: "ADVISOR", advisorId })
    };
}

export async function createSpecialist(label = "Specialist") {
    const user = await User.create({
        name: `${label} ${randomUUID().slice(0, 6)}`,
        email: `${randomUUID()}@example.com`,
        passwordHash: "not-a-real-hash",
        role: "MARKETING_SPECIALIST"
    });
    const userId = String(user._id);

    return { user, userId, token: signToken({ userId, role: "MARKETING_SPECIALIST" }) };
}

export async function createAdmin() {
    const user = await User.create({
        name: `Admin ${randomUUID().slice(0, 6)}`,
        email: `${randomUUID()}@example.com`,
        passwordHash: "not-a-real-hash",
        role: "ADMIN"
    });
    const userId = String(user._id);

    return { user, userId, token: signToken({ userId, role: "ADMIN" }) };
}

export async function createAssignment({ advisorId, specialistUserId, status = "ACCEPTED" }) {
    return AdvisorSpecialistAssignment.create({
        advisorId,
        specialistUserId,
        status,
        acceptedAt: status === "ACCEPTED" ? new Date() : null,
        revokedAt: status === "REVOKED" ? new Date() : null
    });
}

export const revokeAssignment = (assignment) =>
    AdvisorSpecialistAssignment.updateOne(
        { _id: assignment._id },
        { $set: { status: "REVOKED", revokedAt: new Date() } }
    );

// Inserted with the raw collection so assignedSpecialistIds (Member 3's
// Phase II field) is stored even where the Campaign schema does not list it.
export async function createCampaign({
    advisorId,
    status = "ACTIVE",
    channel = "EMAIL",
    assignedSpecialistIds = []
}) {
    const _id = newId();
    const now = new Date();

    await Campaign.collection.insertOne({
        _id,
        advisorId: new mongoose.Types.ObjectId(advisorId),
        title: `Campaign ${String(_id).slice(-6)}`,
        description: "",
        strategy: "NEWSLETTER",
        channel,
        status,
        audience: { interests: [], leadStatuses: [] },
        templateId: null,
        scheduledAt: null,
        completedAt: null,
        assignedSpecialistIds: assignedSpecialistIds.map((id) => new mongoose.Types.ObjectId(id)),
        createdAt: now,
        updatedAt: now
    });

    return String(_id);
}

export async function createLead({ advisorId, status = "NEW" }) {
    const lead = await Lead.create({
        advisorId,
        name: "Test Lead",
        email: `${randomUUID()}@example.com`,
        interest: "Retirement planning",
        status,
        marketingConsent: true
    });

    return String(lead._id);
}

export async function createDeliveryJob({ advisorId, campaignId, deliveryStatus = "PENDING" }) {
    const job = await DeliveryJob.create({
        advisorId,
        campaignId,
        channel: "EMAIL",
        recipientEmail: `${randomUUID()}@example.com`,
        content: { subject: "Test", body: "Test body" },
        deliveryStatus
    });

    return String(job._id);
}

export const randomObjectId = () => String(newId());

// A ready-made body for POST /automations.
export const ruleBody = (overrides = {}) => ({
    name: "Welcome new leads",
    trigger: "LEAD_CREATED",
    action: "CREATE_NOTIFICATION",
    ...overrides
});

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
