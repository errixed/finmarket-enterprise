import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import * as repo from "../campaignRepository.js";
import { createCampaignService } from "../campaignService.js";
import AdvisorProfile from "../../identity/models/AdvisorProfile.js";
import User from "../../identity/models/User.js";
import Lead from "../../leads/models/Lead.js";
import Campaign from "../models/Campaign.js";
import Template from "../models/Template.js";

test(
  "MongoDB persistence, eligibility and restart/reconnect",
  { skip: !process.env.CAMPAIGN_TEST_MONGO_URI },
  async () => {
    const uri = process.env.CAMPAIGN_TEST_MONGO_URI;
    const dbName = `campaign_phase2_test_${new mongoose.Types.ObjectId()}`;
    const connect = () =>
      mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10000 });
    try {
      await connect();
      await Promise.all([
        Campaign.init(),
        Template.init(),
        Lead.init(),
        User.init(),
        AdvisorProfile.init(),
      ]);
      const user = await User.create({
        name: "Fixture Advisor",
        email: "advisor@example.invalid",
        passwordHash: "test-only-not-a-secret",
        role: "ADVISOR",
      });
      const profile = await AdvisorProfile.create({ userId: user._id });
      const advisorId = String(profile._id);
      const service = createCampaignService();
      const template = await service.createTemplate({
        advisorId,
        name: "Fixture",
        channel: "EMAIL",
        body: "Example",
      });
      const campaign = await service.createCampaign({
        advisorId,
        title: "Fixture Campaign",
        strategy: "NEWSLETTER",
        channel: "EMAIL",
        templateId: template._id,
        audience: { interests: ["Retirement"], leadStatuses: ["NEW"] },
      });
      await Lead.create([
        {
          advisorId,
          name: "Eligible",
          email: "a@example.invalid",
          interest: "retirement",
          marketingConsent: true,
        },
        {
          advisorId,
          name: "No consent",
          email: "b@example.invalid",
          interest: "Retirement",
          marketingConsent: false,
        },
        {
          advisorId,
          name: "Unsubscribed",
          email: "c@example.invalid",
          interest: "Retirement",
          marketingConsent: true,
          unsubscribedAt: new Date(),
        },
        {
          advisorId,
          name: "Wrong interest",
          email: "d@example.invalid",
          interest: "Other",
          marketingConsent: true,
        },
        {
          advisorId,
          name: "Wrong status",
          email: "e@example.invalid",
          interest: "Retirement",
          status: "CONTACTED",
          marketingConsent: true,
        },
        {
          advisorId: new mongoose.Types.ObjectId(),
          name: "Other owner",
          email: "f@example.invalid",
          interest: "Retirement",
          marketingConsent: true,
        },
      ]);
      const activated = await service.updateCampaign({
        advisorId,
        campaignId: campaign._id,
        payload: { status: "ACTIVE" },
      });
      assert.equal(activated.status, "ACTIVE");
      assert.equal(
        (await service.getAudience({ advisorId, campaignId: campaign._id }))
          .count,
        1,
      );
      await mongoose.disconnect();
      await connect();
      assert.equal(
        (await repo.findCampaign({ advisorId, campaignId: campaign._id }))
          .status,
        "ACTIVE",
      );
      assert.equal(
        (await repo.findTemplate({ advisorId, templateId: template._id })).name,
        "Fixture",
      );
    } finally {
      if (
        mongoose.connection.readyState === 1 &&
        mongoose.connection.name === dbName
      )
        await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
