import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose, { Types } from "mongoose";

import User from "../../src/modules/identity/models/User.js";
import AdvisorProfile from "../../src/modules/identity/models/AdvisorProfile.js";
import AdvisorSpecialistAssignment from "../../src/modules/identity/models/AdvisorSpecialistAssignment.js";
import Lead from "../../src/modules/leads/models/Lead.js";
import DeliveryJob from "../../src/modules/delivery/models/DeliveryJob.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.resolve(__dirname, "../../../.env");

const readJwtSecret = () => {
    if (process.env.JWT_SECRET) {
        return process.env.JWT_SECRET.trim();
    }
    if (fs.existsSync(rootEnvPath)) {
        const match = fs
            .readFileSync(rootEnvPath, "utf8")
            .match(/^JWT_SECRET=(.+)$/m);
        if (match) return match[1].trim();
    }
    throw new Error("JWT_SECRET not found in environment or root .env file.");
};

const signJwt = (payload, secret) => {
    const header = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" })
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
        .createHmac("sha256", secret)
        .update(`${header}.${body}`)
        .digest("base64url");
    return `${header}.${body}.${signature}`;
};

const MONGO_URI =
    process.env.MONGO_URI ||
    "mongodb://127.0.0.1:27017/finmarket_enterprise?directConnection=true";

const FIXTURE_EMAIL_REGEX = /^delivery\.fixture\..+@example\.com$/i;

const run = async () => {
    const secret = readJwtSecret();
    await mongoose.connect(MONGO_URI);

    try {
        // Clean up any previous fixture run so the script is safely repeatable
        const existingUsers = await User.find({
            email: FIXTURE_EMAIL_REGEX
        }).lean();

        if (existingUsers.length > 0) {
            const userIds = existingUsers.map((u) => u._id);
            const existingProfiles = await AdvisorProfile.find({
                userId: { $in: userIds }
            }).lean();
            const profileIds = existingProfiles.map((p) => p._id);

            await Promise.all([
                DeliveryJob.deleteMany({ advisorId: { $in: profileIds } }),
                Lead.deleteMany({ advisorId: { $in: profileIds } }),
                mongoose.connection
                    .collection("campaigns")
                    .deleteMany({ advisorId: { $in: profileIds } }),
                AdvisorSpecialistAssignment.deleteMany({
                    $or: [
                        { advisorId: { $in: profileIds } },
                        { specialistUserId: { $in: userIds } }
                    ]
                }),
                AdvisorProfile.deleteMany({ _id: { $in: profileIds } }),
                User.deleteMany({ _id: { $in: userIds } })
            ]);
        }

        const advisorUser = await User.create({
            name: "Delivery Fixture Advisor 1",
            email: "delivery.fixture.advisor1@example.com",
            passwordHash: "fixture-hash",
            role: "ADVISOR",
            isActive: true
        });

        const advisorProfile = await AdvisorProfile.create({
            userId: advisorUser._id,
            specialties: ["Retirement Planning"],
            consultationTypes: ["ONLINE"]
        });

        const otherAdvisorUser = await User.create({
            name: "Delivery Fixture Advisor 2",
            email: "delivery.fixture.advisor2@example.com",
            passwordHash: "fixture-hash",
            role: "ADVISOR",
            isActive: true
        });

        const otherAdvisorProfile = await AdvisorProfile.create({
            userId: otherAdvisorUser._id,
            specialties: ["Wealth Management"],
            consultationTypes: ["ONLINE"]
        });

        const specialistUser = await User.create({
            name: "Delivery Fixture Specialist (Assigned)",
            email: "delivery.fixture.specialist1@example.com",
            passwordHash: "fixture-hash",
            role: "MARKETING_SPECIALIST",
            isActive: true
        });

        const unassignedSpecialistUser = await User.create({
            name: "Delivery Fixture Specialist (Unassigned)",
            email: "delivery.fixture.specialist2@example.com",
            passwordHash: "fixture-hash",
            role: "MARKETING_SPECIALIST",
            isActive: true
        });

        await AdvisorSpecialistAssignment.create({
            advisorId: advisorProfile._id,
            specialistUserId: specialistUser._id,
            status: "ACCEPTED",
            acceptedAt: new Date()
        });

        const emailCampaignId = new Types.ObjectId();
        const facebookCampaignId = new Types.ObjectId();
        const draftCampaignId = new Types.ObjectId();
        const otherCampaignId = new Types.ObjectId();

        await mongoose.connection.collection("campaigns").insertMany([
            {
                _id: emailCampaignId,
                advisorId: advisorProfile._id,
                title: "Fixture Active Email Campaign",
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
            },
            {
                _id: facebookCampaignId,
                advisorId: advisorProfile._id,
                title: "Fixture Active Facebook Campaign",
                strategy: "RETIREMENT_PLANNING",
                channel: "FACEBOOK",
                status: "ACTIVE",
                audience: { interests: [], leadStatuses: [] },
                assignedSpecialistIds: [specialistUser._id],
                createdAt: new Date(),
                updatedAt: new Date()
            },
            {
                _id: draftCampaignId,
                advisorId: advisorProfile._id,
                title: "Fixture Draft Email Campaign",
                strategy: "NEWSLETTER",
                channel: "EMAIL",
                status: "DRAFT",
                audience: { interests: [], leadStatuses: [] },
                assignedSpecialistIds: [],
                createdAt: new Date(),
                updatedAt: new Date()
            },
            {
                _id: otherCampaignId,
                advisorId: otherAdvisorProfile._id,
                title: "Fixture Other Advisor Campaign",
                strategy: "RETIREMENT_PLANNING",
                channel: "FACEBOOK",
                status: "ACTIVE",
                audience: { interests: [], leadStatuses: [] },
                assignedSpecialistIds: [],
                createdAt: new Date(),
                updatedAt: new Date()
            }
        ]);

        const consentingLead = await Lead.create({
            advisorId: advisorProfile._id,
            name: "Consenting Test Lead",
            email: "delivery.fixture.lead.consent@example.com",
            interest: "Retirement Planning",
            status: "NEW",
            marketingConsent: true,
            consentRecordedAt: new Date(),
            unsubscribedAt: null
        });

        const noConsentLead = await Lead.create({
            advisorId: advisorProfile._id,
            name: "No Consent Test Lead",
            email: "delivery.fixture.lead.noconsent@example.com",
            interest: "Retirement Planning",
            status: "NEW",
            marketingConsent: false
        });

        const unsubscribedLead = await Lead.create({
            advisorId: advisorProfile._id,
            name: "Unsubscribed Test Lead",
            email: "delivery.fixture.lead.unsub@example.com",
            interest: "Retirement Planning",
            status: "NEW",
            marketingConsent: true,
            unsubscribedAt: new Date()
        });

        const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 12;

        const postmanVariables = {
            baseUrl: "http://localhost:8080/api/v1",
            advisorId: String(advisorProfile._id),
            otherAdvisorId: String(otherAdvisorProfile._id),
            emailCampaignId: String(emailCampaignId),
            facebookCampaignId: String(facebookCampaignId),
            draftCampaignId: String(draftCampaignId),
            otherCampaignId: String(otherCampaignId),
            consentingLeadId: String(consentingLead._id),
            noConsentLeadId: String(noConsentLead._id),
            unsubscribedLeadId: String(unsubscribedLead._id),
            advisorToken: signJwt({ sub: String(advisorUser._id), exp }, secret),
            otherAdvisorToken: signJwt(
                { sub: String(otherAdvisorUser._id), exp },
                secret
            ),
            specialistToken: signJwt(
                { sub: String(specialistUser._id), exp },
                secret
            ),
            unassignedSpecialistToken: signJwt(
                { sub: String(unassignedSpecialistUser._id), exp },
                secret
            )
        };

        console.log("\n=== POSTMAN COLLECTION VARIABLES (LOCAL DEV ONLY) ===\n");
        console.log(JSON.stringify(postmanVariables, null, 2));
    } finally {
        await mongoose.disconnect();
    }
};

run().catch((err) => {
    console.error("Failed to seed delivery fixtures:", err);
    process.exitCode = 1;
});