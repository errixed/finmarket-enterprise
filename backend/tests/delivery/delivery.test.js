import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import mongoose, { Types } from "mongoose";

import DeliveryJob from "../../src/modules/delivery/models/DeliveryJob.js";
import * as repo from "../../src/modules/delivery/repositories/deliveryRepository.js";
import * as service from "../../src/modules/delivery/services/deliveryService.js";
import { processDueDeliveries } from "../../src/modules/delivery/services/deliveryWorker.js";
import {
    setDeliveryContracts,
    resetDeliveryContracts,
    registerDeliveryEventListener
} from "../../src/modules/delivery/contracts/deliveryContracts.js";
import {
    resolveProviderName,
    dispatchToProvider
} from "../../src/modules/delivery/providers/providerRegistry.js";
import {
    createDeliveryRateLimiter,
    deliveryRateLimiter
} from "../../src/modules/delivery/providers/deliveryRateLimiter.js";
import deliveryRoutes from "../../src/modules/delivery/routes/deliveryRoutes.js";

import User from "../../src/modules/identity/models/User.js";
import AdvisorProfile from "../../src/modules/identity/models/AdvisorProfile.js";
import AdvisorSpecialistAssignment from "../../src/modules/identity/models/AdvisorSpecialistAssignment.js";
import Lead from "../../src/modules/leads/models/Lead.js";
import Campaign from "../../src/modules/campaigns/models/Campaign.js";

const TEST_MONGO_URI =
    process.env.DELIVERY_TEST_MONGO_URI ||
    "mongodb://127.0.0.1:27017/finmarket_enterprise_delivery_test?directConnection=true";

const TEST_JWT_SECRET =
    process.env.JWT_SECRET || "delivery_phase2_test_jwt_secret_2026";

process.env.JWT_SECRET = TEST_JWT_SECRET;

let server;
let baseUrl;

const oid = () => new Types.ObjectId().toString();

const signJwt = (payload, secret = TEST_JWT_SECRET) => {
    const header = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" })
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto
        .createHmac("sha256", secret)
        .update(`${header}.${body}`)
        .digest("base64url");
    return `${header}.${body}.${sig}`;
};

const apiRequest = async (path, { method = "GET", token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const json = await response.json().catch(() => null);
    return { status: response.status, body: json };
};

const createFixtureSet = async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    const advisorUser = await User.create({
        name: "Advisor One",
        email: `advisor1.${suffix}@example.com`,
        passwordHash: "test-hash",
        role: "ADVISOR",
        isActive: true
    });

    const advisorProfile = await AdvisorProfile.create({
        userId: advisorUser._id,
        specialties: ["Retirement Planning"],
        consultationTypes: ["ONLINE"]
    });

    const otherAdvisorUser = await User.create({
        name: "Advisor Two",
        email: `advisor2.${suffix}@example.com`,
        passwordHash: "test-hash",
        role: "ADVISOR",
        isActive: true
    });

    const otherAdvisorProfile = await AdvisorProfile.create({
        userId: otherAdvisorUser._id,
        specialties: ["Wealth Management"],
        consultationTypes: ["ONLINE"]
    });

    const specialistUser = await User.create({
        name: "Specialist One",
        email: `specialist1.${suffix}@example.com`,
        passwordHash: "test-hash",
        role: "MARKETING_SPECIALIST",
        isActive: true
    });

    const unassignedSpecialistUser = await User.create({
        name: "Specialist Two",
        email: `specialist2.${suffix}@example.com`,
        passwordHash: "test-hash",
        role: "MARKETING_SPECIALIST",
        isActive: true
    });

    const adminUser = await User.create({
        name: "Platform Admin",
        email: `admin.${suffix}@example.com`,
        passwordHash: "test-hash",
        role: "ADMIN",
        isActive: true
    });

    const assignment = await AdvisorSpecialistAssignment.create({
        advisorId: advisorProfile._id,
        specialistUserId: specialistUser._id,
        status: "ACCEPTED",
        acceptedAt: new Date()
    });

    const emailCampaignId = new Types.ObjectId();
    await mongoose.connection.collection("campaigns").insertOne({
        _id: emailCampaignId,
        advisorId: advisorProfile._id,
        title: "Retirement Email Campaign",
        strategy: "RETIREMENT_PLANNING",
        channel: "EMAIL",
        status: "ACTIVE",
        audience: {
            interests: ["Retirement Planning"],
            leadStatuses: ["NEW", "CONTACTED"]
        },
        assignedSpecialistIds: [specialistUser._id],
        createdAt: new Date(),
        updatedAt: new Date()
    });

    const facebookCampaignId = new Types.ObjectId();
    await mongoose.connection.collection("campaigns").insertOne({
        _id: facebookCampaignId,
        advisorId: advisorProfile._id,
        title: "Retirement Facebook Campaign",
        strategy: "RETIREMENT_PLANNING",
        channel: "FACEBOOK",
        status: "ACTIVE",
        audience: { interests: [], leadStatuses: [] },
        assignedSpecialistIds: [specialistUser._id],
        createdAt: new Date(),
        updatedAt: new Date()
    });

    const draftCampaignId = new Types.ObjectId();
    await mongoose.connection.collection("campaigns").insertOne({
        _id: draftCampaignId,
        advisorId: advisorProfile._id,
        title: "Draft Email Campaign",
        strategy: "NEWSLETTER",
        channel: "EMAIL",
        status: "DRAFT",
        audience: { interests: [], leadStatuses: [] },
        assignedSpecialistIds: [],
        createdAt: new Date(),
        updatedAt: new Date()
    });

    const otherCampaignId = new Types.ObjectId();
    await mongoose.connection.collection("campaigns").insertOne({
        _id: otherCampaignId,
        advisorId: otherAdvisorProfile._id,
        title: "Other Advisor Campaign",
        strategy: "RETIREMENT_PLANNING",
        channel: "EMAIL",
        status: "ACTIVE",
        audience: { interests: ["Retirement Planning"], leadStatuses: ["NEW"] },
        assignedSpecialistIds: [],
        createdAt: new Date(),
        updatedAt: new Date()
    });

    const consentingLead = await Lead.create({
        advisorId: advisorProfile._id,
        name: "Consenting Lead",
        email: `consent.${suffix}@example.com`,
        interest: "Retirement Planning",
        status: "NEW",
        marketingConsent: true,
        consentRecordedAt: new Date(),
        unsubscribedAt: null
    });

    const noConsentLead = await Lead.create({
        advisorId: advisorProfile._id,
        name: "No Consent Lead",
        email: `noconsent.${suffix}@example.com`,
        interest: "Retirement Planning",
        status: "NEW",
        marketingConsent: false
    });

    const unsubscribedLead = await Lead.create({
        advisorId: advisorProfile._id,
        name: "Unsubscribed Lead",
        email: `unsub.${suffix}@example.com`,
        interest: "Retirement Planning",
        status: "NEW",
        marketingConsent: true,
        unsubscribedAt: new Date()
    });

    const outOfAudienceLead = await Lead.create({
        advisorId: advisorProfile._id,
        name: "Out Of Audience Lead",
        email: `outside.${suffix}@example.com`,
        interest: "Estate Tax",
        status: "CONVERTED",
        marketingConsent: true
    });

    const otherAdvisorLead = await Lead.create({
        advisorId: otherAdvisorProfile._id,
        name: "Other Advisor Lead",
        email: `other.${suffix}@example.com`,
        interest: "Retirement Planning",
        status: "NEW",
        marketingConsent: true
    });

    const exp = Math.floor(Date.now() / 1000) + 3600;

    return {
        advisorUser,
        advisorProfile,
        otherAdvisorUser,
        otherAdvisorProfile,
        specialistUser,
        unassignedSpecialistUser,
        adminUser,
        assignment,
        emailCampaignId: String(emailCampaignId),
        facebookCampaignId: String(facebookCampaignId),
        draftCampaignId: String(draftCampaignId),
        otherCampaignId: String(otherCampaignId),
        consentingLead,
        noConsentLead,
        unsubscribedLead,
        outOfAudienceLead,
        otherAdvisorLead,
        tokens: {
            advisor: signJwt({ sub: String(advisorUser._id), exp }),
            otherAdvisor: signJwt({ sub: String(otherAdvisorUser._id), exp }),
            specialist: signJwt({ sub: String(specialistUser._id), exp }),
            unassignedSpecialist: signJwt({
                sub: String(unassignedSpecialistUser._id),
                exp
            }),
            admin: signJwt({ sub: String(adminUser._id), exp }),
            expired: signJwt({
                sub: String(advisorUser._id),
                exp: Math.floor(Date.now() / 1000) - 60
            })
        }
    };
};

before(async () => {
    await mongoose.connect(TEST_MONGO_URI);
    await mongoose.connection.db.dropDatabase();
    await DeliveryJob.syncIndexes();

    const app = express();
    app.use(express.json());
    app.use("/api/v1/deliveries", deliveryRoutes);
    app.use((err, _req, res, _next) => {
        const status = err.statusCode || 500;
        res.status(status).json({
            success: false,
            error: {
                code: err.code || "INTERNAL_ERROR",
                message: err.message || "Unexpected error."
            }
        });
    });

    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/api/v1/deliveries`;
});

beforeEach(async () => {
    resetDeliveryContracts();
    deliveryRateLimiter.reset();
    await Promise.all([
        DeliveryJob.deleteMany({}),
        User.deleteMany({}),
        AdvisorProfile.deleteMany({}),
        AdvisorSpecialistAssignment.deleteMany({}),
        Lead.deleteMany({}),
        Campaign.deleteMany({})
    ]);
});

after(async () => {
    resetDeliveryContracts();
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db.dropDatabase();
        await mongoose.disconnect();
    }
});

// ---------------------------------------------------------------------------
// 8.1 Database Persistence & Model Validation
// ---------------------------------------------------------------------------
test("8.1 Persistence: stores, retrieves, updates, and survives reconnection", async () => {
    const created = await repo.createDeliveryJob({
        advisorId: oid(),
        campaignId: oid(),
        channel: "FACEBOOK",
        content: { subject: "", body: "Persistent Facebook update" }
    });

    assert.match(created._id, /^[a-f0-9]{24}$/);
    assert.equal(created.deliveryStatus, "PENDING");
    assert.equal(created.attempts, 0);

    const found = await repo.findDeliveryJobById(created._id);
    assert.equal(found._id, created._id);

    const processing = await repo.updateDeliveryJob(created._id, {
        deliveryStatus: "PROCESSING",
        advisorId: oid() // protected field must not change
    });
    assert.equal(processing.deliveryStatus, "PROCESSING");
    assert.equal(processing.advisorId, created.advisorId);

    const sent = await repo.recordProviderSuccess(created._id, {
        provider: "MOCK_FACEBOOK",
        providerMessageId: "mock-fb-persist",
        simulated: true
    });
    assert.equal(sent.deliveryStatus, "SENT");

    // Verify persistence across a fresh Mongoose reconnection
    await mongoose.disconnect();
    await mongoose.connect(TEST_MONGO_URI);

    const reloaded = await repo.findDeliveryJobById(created._id);
    assert.equal(reloaded.deliveryStatus, "SENT");
    assert.equal(reloaded.providerMessageId, "mock-fb-persist");
});

test("8.1 Schema validation & indexes: rejects invalid documents and enforces indexes", async () => {
    const emailWithoutLead = new DeliveryJob({
        advisorId: oid(),
        campaignId: oid(),
        channel: "EMAIL",
        content: { body: "Missing leadId" }
    });

    await assert.rejects(() => emailWithoutLead.validate());

    const invalidChannel = new DeliveryJob({
        advisorId: oid(),
        campaignId: oid(),
        channel: "SMS",
        content: { body: "Unsupported channel" }
    });

    await assert.rejects(() => invalidChannel.validate());

    const indexes = await DeliveryJob.collection.indexes();
    const indexNames = indexes.map((idx) => Object.keys(idx.key).join(","));
    assert.ok(indexNames.includes("advisorId,createdAt"));
    assert.ok(indexNames.includes("campaignId,deliveryStatus"));
    assert.ok(indexNames.includes("deliveryStatus,scheduledAt"));
    assert.ok(indexNames.includes("idempotencyKey"));
});

// ---------------------------------------------------------------------------
// 8.2 Authentication & Authorization
// ---------------------------------------------------------------------------
test("8.2 Auth: rejects missing, invalid, and expired JWTs", async () => {
    const fx = await createFixtureSet();

    const missing = await apiRequest("/");
    assert.equal(missing.status, 401);

    const invalid = await apiRequest("/", { token: "not.a.valid.jwt" });
    assert.equal(invalid.status, 401);

    const expired = await apiRequest("/", { token: fx.tokens.expired });
    assert.equal(expired.status, 401);
});

test("8.2 Auth: Advisor ownership, client advisorId spoof, and mass assignment protection", async () => {
    const fx = await createFixtureSet();

    // Own campaign succeeds
    const ownRes = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.emailCampaignId,
            leadId: String(fx.consentingLead._id),
            channel: "EMAIL",
            content: { subject: "Welcome", body: "Advisor owned campaign" }
        }
    });
    assert.equal(ownRes.status, 201);
    assert.equal(ownRes.body.data.advisorId, String(fx.advisorProfile._id));

    // Another advisor's campaign rejected
    const otherCampRes = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.otherCampaignId,
            leadId: String(fx.otherAdvisorLead._id),
            channel: "EMAIL",
            content: { subject: "Steal", body: "Not my campaign" }
        }
    });
    assert.equal(otherCampRes.status, 403);

    // Spoofed advisorId cannot override campaign ownership
    const spoofRes = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            advisorId: String(fx.otherAdvisorProfile._id),
            campaignId: fx.facebookCampaignId,
            channel: "FACEBOOK",
            content: { body: "Spoof attempt" }
        }
    });
    assert.equal(spoofRes.status, 403);

    // Mass assignment of protected lifecycle fields rejected
    const massAssignRes = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.facebookCampaignId,
            channel: "FACEBOOK",
            deliveryStatus: "SENT",
            sentAt: new Date().toISOString(),
            content: { body: "Mass assign attempt" }
        }
    });
    assert.equal(massAssignRes.status, 400);
});

test("8.2 Auth: Assigned specialist succeeds, unassigned rejected, revoked relationship invalidates access", async () => {
    const fx = await createFixtureSet();

    // Assigned specialist with ACCEPTED relationship can queue and process
    const queueRes = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.specialist,
        body: {
            campaignId: fx.facebookCampaignId,
            channel: "FACEBOOK",
            content: { body: "Specialist post" }
        }
    });
    assert.equal(queueRes.status, 201);

    // Unassigned specialist rejected
    const unassignedRes = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.unassignedSpecialist,
        body: {
            campaignId: fx.facebookCampaignId,
            channel: "FACEBOOK",
            content: { body: "Unauthorized post" }
        }
    });
    assert.equal(unassignedRes.status, 403);

    // Revoke the relationship -> specialist immediately loses access
    await AdvisorSpecialistAssignment.updateOne(
        { _id: fx.assignment._id },
        { $set: { status: "REVOKED", revokedAt: new Date() } }
    );

    const revokedProcess = await apiRequest(
        `/${queueRes.body.data._id}/process`,
        {
            method: "POST",
            token: fx.tokens.specialist
        }
    );
    assert.equal(revokedProcess.status, 403);
    assert.equal(revokedProcess.body.error.code, "ASSIGNMENT_REQUIRED");
});

// ---------------------------------------------------------------------------
// 8.3 Campaign Validation
// ---------------------------------------------------------------------------
test("8.3 Campaign validation: rejects missing, invalid ID, non-active, and channel mismatch", async () => {
    const fx = await createFixtureSet();

    const invalidId = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: "bad-id",
            channel: "FACEBOOK",
            content: { body: "Bad ID" }
        }
    });
    assert.equal(invalidId.status, 400);

    const missing = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: oid(),
            channel: "FACEBOOK",
            content: { body: "Missing campaign" }
        }
    });
    assert.equal(missing.status, 404);

    const draft = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.draftCampaignId,
            leadId: String(fx.consentingLead._id),
            channel: "EMAIL",
            content: { subject: "Draft", body: "Not active" }
        }
    });
    assert.equal(draft.status, 400);
    assert.equal(draft.body.error.code, "CAMPAIGN_NOT_ACTIVE");

    const wrongChannel = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.emailCampaignId,
            channel: "FACEBOOK",
            content: { body: "Wrong channel" }
        }
    });
    assert.equal(wrongChannel.status, 400);
    assert.equal(wrongChannel.body.error.code, "CHANNEL_MISMATCH");
});

// ---------------------------------------------------------------------------
// 8.4 Recipient Consent & Eligibility
// ---------------------------------------------------------------------------
test("8.4 Consent: enforces consent, unsubscribe, email match, audience, ownership, and post-queue revocation", async () => {
    const fx = await createFixtureSet();

    // No consent rejected
    const noConsent = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.emailCampaignId,
            leadId: String(fx.noConsentLead._id),
            channel: "EMAIL",
            content: { subject: "Hi", body: "No consent" }
        }
    });
    assert.equal(noConsent.status, 403);
    assert.equal(noConsent.body.error.code, "MARKETING_CONSENT_REQUIRED");

    // Unsubscribed lead rejected
    const unsub = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.emailCampaignId,
            leadId: String(fx.unsubscribedLead._id),
            channel: "EMAIL",
            content: { subject: "Hi", body: "Unsubscribed" }
        }
    });
    assert.equal(unsub.status, 403);

    // Mismatched recipient email rejected
    const wrongEmail = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.emailCampaignId,
            leadId: String(fx.consentingLead._id),
            recipientEmail: "different@example.com",
            channel: "EMAIL",
            content: { subject: "Hi", body: "Wrong email" }
        }
    });
    assert.equal(wrongEmail.status, 400);
    assert.equal(wrongEmail.body.error.code, "RECIPIENT_MISMATCH");

    // Lead outside campaign audience rejected
    const outsideAudience = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.emailCampaignId,
            leadId: String(fx.outOfAudienceLead._id),
            channel: "EMAIL",
            content: { subject: "Hi", body: "Outside audience" }
        }
    });
    assert.equal(outsideAudience.status, 403);
    assert.equal(outsideAudience.body.error.code, "LEAD_NOT_IN_AUDIENCE");

    // Lead belonging to another advisor rejected
    const wrongAdvisorLead = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.emailCampaignId,
            leadId: String(fx.otherAdvisorLead._id),
            channel: "EMAIL",
            content: { subject: "Hi", body: "Wrong advisor lead" }
        }
    });
    assert.equal(wrongAdvisorLead.status, 403);
    assert.equal(wrongAdvisorLead.body.error.code, "LEAD_ADVISOR_MISMATCH");

    // Valid consenting lead queues cleanly
    const queued = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.emailCampaignId,
            leadId: String(fx.consentingLead._id),
            channel: "EMAIL",
            content: { subject: "Plan", body: "Eligible email" }
        }
    });
    assert.equal(queued.status, 201);

    // Withdraw consent AFTER queueing -> processing MUST fail
    await Lead.updateOne(
        { _id: fx.consentingLead._id },
        { $set: { unsubscribedAt: new Date() } }
    );

    const blockedProcess = await apiRequest(
        `/${queued.body.data._id}/process`,
        {
            method: "POST",
            token: fx.tokens.advisor
        }
    );
    assert.equal(blockedProcess.status, 403);
    assert.equal(blockedProcess.body.error.code, "MARKETING_CONSENT_REQUIRED");

    // Restore consent -> processing succeeds via mock email provider
    await Lead.updateOne(
        { _id: fx.consentingLead._id },
        { $set: { unsubscribedAt: null } }
    );

    const sent = await apiRequest(`/${queued.body.data._id}/process`, {
        method: "POST",
        token: fx.tokens.advisor
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.deliveryStatus, "SENT");
    assert.equal(sent.body.data.provider, "MOCK_EMAIL");
    assert.equal(sent.body.data.simulated, true);
});

// ---------------------------------------------------------------------------
// 8.5 Queue Processing, Scheduling, Atomic Claims & Retries
// ---------------------------------------------------------------------------
test("8.5 Queue processing: blocks early scheduled runs, prevents concurrent double-send, and enforces retry policy", async () => {
    const fx = await createFixtureSet();

    // Future scheduled job cannot be processed early
    const futureRes = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.facebookCampaignId,
            channel: "FACEBOOK",
            scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
            content: { body: "Scheduled for later" }
        }
    });
    assert.equal(futureRes.status, 201);

    const earlyProcess = await apiRequest(
        `/${futureRes.body.data._id}/process`,
        {
            method: "POST",
            token: fx.tokens.advisor
        }
    );
    assert.equal(earlyProcess.status, 409);
    assert.equal(earlyProcess.body.error.code, "DELIVERY_NOT_DUE");

    // Concurrent processing attempts only send once
    const dueRes = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.facebookCampaignId,
            channel: "FACEBOOK",
            idempotencyKey: `idem-${Date.now()}`,
            content: { body: "Atomic concurrency post" }
        }
    });
    assert.equal(dueRes.status, 201);

    // Duplicate idempotencyKey rejected
    const dupIdem = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.facebookCampaignId,
            channel: "FACEBOOK",
            idempotencyKey: dueRes.body.data.idempotencyKey,
            content: { body: "Different body same key" }
        }
    });
    assert.equal(dupIdem.status, 409);

    const [p1, p2] = await Promise.all([
        apiRequest(`/${dueRes.body.data._id}/process`, {
            method: "POST",
            token: fx.tokens.advisor
        }),
        apiRequest(`/${dueRes.body.data._id}/process`, {
            method: "POST",
            token: fx.tokens.advisor
        })
    ]);

    const statuses = [p1.status, p2.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const processedJob = await repo.findDeliveryJobById(dueRes.body.data._id);
    assert.equal(processedJob.deliveryStatus, "SENT");
    assert.equal(processedJob.attempts, 1);
    assert.ok(processedJob.sentAt);
    assert.ok(processedJob.processingStartedAt);

    // Already SENT job cannot be processed again
    const replay = await apiRequest(`/${dueRes.body.data._id}/process`, {
        method: "POST",
        token: fx.tokens.advisor
    });
    assert.equal(replay.status, 409);

    // Failed job can be retried explicitly, then succeeds
    const auth = {
        userId: String(fx.advisorUser._id),
        role: "ADVISOR",
        advisorId: String(fx.advisorProfile._id)
    };
    const failCandidate = await service.queueDelivery(
        {
            campaignId: fx.facebookCampaignId,
            channel: "FACEBOOK",
            content: { body: "Will fail once then retry" }
        },
        auth
    );

    const failed = await service.processDelivery(failCandidate._id, auth, {
        providerOverride: "META_FACEBOOK",
        pageId: "",
        accessToken: ""
    });
    assert.equal(failed.deliveryStatus, "FAILED");
    assert.ok(failed.errorMessage);

    const retried = await apiRequest(`/${failCandidate._id}/retry`, {
        method: "POST",
        token: fx.tokens.advisor
    });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.data.deliveryStatus, "PENDING");

    // Due-job worker processes due job and leaves future scheduled job PENDING
    const workerResult = await processDueDeliveries({ limit: 10 });
    assert.equal(workerResult.processed, 1);

    const futureAfterWorker = await repo.findDeliveryJobById(
        futureRes.body.data._id
    );
    assert.equal(futureAfterWorker.deliveryStatus, "PENDING");
});

// ---------------------------------------------------------------------------
// 8.6 Provider Integration & Rate Limiting
// ---------------------------------------------------------------------------
test("8.6 Providers & Rate Limiter: config selection, credential redaction, and rate limits", async () => {
    assert.equal(resolveProviderName("EMAIL", {}), "MOCK_EMAIL");
    assert.equal(
        resolveProviderName("EMAIL", { DELIVERY_EMAIL_PROVIDER: "gmail" }),
        "GMAIL_SMTP"
    );
    assert.equal(resolveProviderName("FACEBOOK", {}), "MOCK_FACEBOOK");
    assert.equal(
        resolveProviderName("FACEBOOK", { DELIVERY_FACEBOOK_PROVIDER: "meta" }),
        "META_FACEBOOK"
    );

    // Redacts Gmail secret on transporter error
    const secretPass = "super-secret-app-password-999";
    const gmailErr = await dispatchToProvider(
        {
            channel: "EMAIL",
            recipientEmail: "test@example.com",
            content: { subject: "Test", body: "Hello" }
        },
        {
            providerOverride: "GMAIL_SMTP",
            user: "sender@example.com",
            pass: secretPass,
            transporter: {
                sendMail: async () => {
                    throw new Error(`SMTP auth failed for ${secretPass}`);
                }
            }
        }
    );
    assert.equal(gmailErr.success, false);
    assert.ok(!gmailErr.errorMessage.includes(secretPass));
    assert.ok(gmailErr.errorMessage.includes("[REDACTED]"));

    // Redacts Meta access token on Graph API error
    const secretToken = "EAAG-secret-meta-token-xyz";
    const metaErr = await dispatchToProvider(
        {
            channel: "FACEBOOK",
            content: { body: "Graph post" }
        },
        {
            providerOverride: "META_FACEBOOK",
            pageId: "12345",
            accessToken: secretToken,
            fetchImpl: async () => ({
                ok: false,
                status: 403,
                json: async () => ({
                    error: { message: `Invalid token ${secretToken}` }
                })
            })
        }
    );
    assert.equal(metaErr.success, false);
    assert.ok(!metaErr.errorMessage.includes(secretToken));
    assert.ok(metaErr.errorMessage.includes("[REDACTED]"));

    // Rate limiting caps sends cleanly
    const limiter = createDeliveryRateLimiter({
        maxRequests: 2,
        windowMs: 60_000,
        maxConcurrent: 1
    });

    await limiter.run("MOCK_EMAIL", async () => "ok1");
    await limiter.run("MOCK_EMAIL", async () => "ok2");
    await assert.rejects(
        () => limiter.run("MOCK_EMAIL", async () => "ok3"),
        { statusCode: 429, code: "DELIVERY_RATE_LIMITED" }
    );
});

// ---------------------------------------------------------------------------
// 8.7 Delivery History, Filtering, Pagination & Scoping
// ---------------------------------------------------------------------------
test("8.7 History: filters by campaign/channel/status, paginates, and scopes by Advisor & Specialist", async () => {
    const fx = await createFixtureSet();

    const j1 = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.emailCampaignId,
            leadId: String(fx.consentingLead._id),
            channel: "EMAIL",
            content: { subject: "Email 1", body: "History email" }
        }
    });
    const j2 = await apiRequest("/", {
        method: "POST",
        token: fx.tokens.advisor,
        body: {
            campaignId: fx.facebookCampaignId,
            channel: "FACEBOOK",
            content: { body: "History facebook" }
        }
    });
    await apiRequest(`/${j1.body.data._id}/process`, {
        method: "POST",
        token: fx.tokens.advisor
    });

    // Other advisor queues on their own campaign
    await apiRequest("/", {
        method: "POST",
        token: fx.tokens.otherAdvisor,
        body: {
            campaignId: fx.otherCampaignId,
            leadId: String(fx.otherAdvisorLead._id),
            channel: "EMAIL",
            content: { subject: "Other", body: "Other advisor job" }
        }
    });

    // Advisor sees only their 2 jobs, paginated cleanly
    const page1 = await apiRequest("/?page=1&limit=1", {
        token: fx.tokens.advisor
    });
    assert.equal(page1.status, 200);
    assert.equal(page1.body.data.length, 1);
    assert.equal(page1.body.pagination.total, 2);
    assert.equal(page1.body.pagination.totalPages, 2);

    // Filter by status & channel
    const sentOnly = await apiRequest("/?deliveryStatus=SENT&channel=EMAIL", {
        token: fx.tokens.advisor
    });
    assert.equal(sentOnly.body.data.length, 1);
    assert.equal(sentOnly.body.data[0]._id, j1.body.data._id);

    // Filter by campaignId
    const fbOnly = await apiRequest(`/?campaignId=${fx.facebookCampaignId}`, {
        token: fx.tokens.advisor
    });
    assert.equal(fbOnly.body.data.length, 1);
    assert.equal(fbOnly.body.data[0]._id, j2.body.data._id);

    // Advisor cannot query another advisor's advisorId
    const crossAdvisor = await apiRequest(
        `/?advisorId=${fx.otherAdvisorProfile._id}`,
        { token: fx.tokens.advisor }
    );
    assert.equal(crossAdvisor.status, 403);

    // Assigned specialist sees only their assigned campaigns (2 jobs, not other advisor's)
    const specHistory = await apiRequest("/", { token: fx.tokens.specialist });
    assert.equal(specHistory.status, 200);
    assert.equal(specHistory.body.data.length, 2);

    // Unassigned specialist sees zero jobs
    const unassignedHistory = await apiRequest("/", {
        token: fx.tokens.unassignedSpecialist
    });
    assert.equal(unassignedHistory.status, 200);
    assert.equal(unassignedHistory.body.data.length, 0);
});

// ---------------------------------------------------------------------------
// 8.8 Integration Contract Tests (Automation & Events)
// ---------------------------------------------------------------------------
test("8.8 Contracts: Automation queueing enforces consent and emits shared lifecycle events", async () => {
    const fx = await createFixtureSet();
    const events = [];
    const unsubscribe = registerDeliveryEventListener((evt) => {
        events.push(evt);
    });

    try {
        // Automation cannot bypass lead consent
        await assert.rejects(
            () =>
                service.queueDeliveryForAutomation({
                    advisorId: String(fx.advisorProfile._id),
                    campaignId: fx.emailCampaignId,
                    leadId: String(fx.noConsentLead._id),
                    channel: "EMAIL",
                    content: { subject: "Auto", body: "Blocked auto email" }
                }),
            { statusCode: 403, code: "MARKETING_CONSENT_REQUIRED" }
        );

        // Valid Automation request succeeds and emits DELIVERY_QUEUED -> DELIVERY_SENT
        const autoJob = await service.queueDeliveryForAutomation({
            advisorId: String(fx.advisorProfile._id),
            campaignId: fx.emailCampaignId,
            leadId: String(fx.consentingLead._id),
            channel: "EMAIL",
            content: { subject: "Auto", body: "Follow-up email" }
        });

        await service.processDeliveryInternal(autoJob._id);

        assert.deepEqual(
            events.map((e) => e.eventType),
            ["DELIVERY_QUEUED", "DELIVERY_SENT"]
        );
        assert.equal(events[0].entityType, "DELIVERY_JOB");
        assert.equal(events[0].metadata.campaignId, fx.emailCampaignId);
        assert.equal(events[1].metadata.source, undefined);
        assert.ok(events[1].eventId);
        assert.ok(events[1].occurredAt);
    } finally {
        unsubscribe();
    }
});

test("8.8 Contracts: works independently with mocked external contracts", async () => {
    const mockAdvisorId = oid();
    const mockCampaignId = oid();
    const mockLeadId = oid();

    setDeliveryContracts({
        findCampaignById: async (id) =>
            String(id) === mockCampaignId
                ? {
                      _id: mockCampaignId,
                      advisorId: mockAdvisorId,
                      status: "ACTIVE",
                      channel: "EMAIL",
                      audience: { interests: ["Retirement"], leadStatuses: ["NEW"] }
                  }
                : null,
        findLeadById: async (id) =>
            String(id) === mockLeadId
                ? {
                      _id: mockLeadId,
                      advisorId: mockAdvisorId,
                      email: "mocked@example.com",
                      interest: "Retirement",
                      status: "NEW",
                      marketingConsent: true,
                      unsubscribedAt: null
                  }
                : null,
        isLeadInCampaignAudience: async () => true
    });

    const auth = {
        userId: oid(),
        role: "ADVISOR",
        advisorId: mockAdvisorId
    };

    const queued = await service.queueDelivery(
        {
            campaignId: mockCampaignId,
            leadId: mockLeadId,
            channel: "EMAIL",
            content: { subject: "Mocked", body: "Independent contract test" }
        },
        auth
    );

    const sent = await service.processDelivery(queued._id, auth);
    assert.equal(sent.deliveryStatus, "SENT");
    assert.equal(sent.provider, "MOCK_EMAIL");
});