import test from "node:test";
import assert from "node:assert/strict";
import { createCampaignAccess } from "../campaignAccess.js";
import { createCampaignService } from "../campaignService.js";
import Campaign from "../models/Campaign.js";
import Template from "../models/Template.js";

const advisorUser = "100000000000000000000001";
const advisor = "200000000000000000000001";
const other = "200000000000000000000002";
const specialist = "300000000000000000000001";
const campaignId = "400000000000000000000001";
const templateId = "500000000000000000000001";
const owner = { userId: advisorUser };
const member = { userId: specialist };
function fixture() {
  let accepted = true;
  const campaign = {
    _id: campaignId,
    advisorId: advisor,
    assignedSpecialistIds: [specialist],
    status: "DRAFT",
    channel: "EMAIL",
    templateId,
    audience: { interests: [], leadStatuses: [] },
    __v: 0,
  };
  const repo = {
    findUser: async (id) =>
      id === advisorUser
        ? { role: "ADVISOR" }
        : id === specialist
          ? { role: "MARKETING_SPECIALIST" }
          : null,
    findAdvisorByUser: async () => ({ _id: advisor }),
    findAdvisor: async (id) => (id === advisor ? { _id: advisor } : null),
    hasAcceptedRelationship: async () => accepted,
    acceptedAdvisorIds: async () => (accepted ? [advisor] : []),
    findCampaign: async () => campaign,
    listCampaigns: async (filter) =>
      filter.advisorIds?.length === 0 ? [] : [campaign],
    findTemplate: async () => ({
      _id: templateId,
      advisorId: advisor,
      channel: "EMAIL",
    }),
    findAudience: async () => [
      { _id: "600000000000000000000001", email: "fixture@example.invalid" },
    ],
    createCampaign: async (data) => data,
    updateCampaign: async ({ changes, version }) => {
      assert.equal(version, campaign.__v);
      Object.assign(campaign, changes);
      campaign.__v++;
      return campaign;
    },
    changeAssignment: async ({ userId, add }) => {
      const present = campaign.assignedSpecialistIds.includes(userId);
      if (present === add) return null;
      campaign.assignedSpecialistIds = add
        ? [...campaign.assignedSpecialistIds, userId]
        : campaign.assignedSpecialistIds.filter((v) => v !== userId);
      return campaign;
    },
  };
  const service = createCampaignService(repo);
  return {
    campaign,
    repo,
    service,
    access: createCampaignAccess(service, repo),
    revoke: () => {
      accepted = false;
    },
  };
}
const status = (expected) => (error) => error.statusCode === expected;
test("reject unauthenticated requests and ownership spoofing", async () => {
  const { access } = fixture();
  await assert.rejects(access.getCampaign(null, campaignId), status(401));
  await assert.rejects(
    access.createCampaign(owner, { advisorId: other }),
    status(403),
  );
  await assert.rejects(access.createCampaign(member, {}), status(403));
  await assert.rejects(
    access.listCampaigns(owner, { advisorId: other }),
    status(403),
  );
});
test("specialist requires both assignment and current relationship", async () => {
  const { access, campaign, revoke } = fixture();
  assert.equal((await access.getCampaign(member, campaignId))._id, campaignId);
  campaign.assignedSpecialistIds = [];
  await assert.rejects(access.getCampaign(member, campaignId), status(403));
  campaign.assignedSpecialistIds = [specialist];
  revoke();
  await assert.rejects(access.getCampaign(member, campaignId), status(403));
  assert.deepEqual(await access.listCampaigns(member, {}), []);
});
test("specialist sees counts only and cannot change lifecycle or assignment", async () => {
  const { access } = fixture();
  const audience = await access.getAudience(member, campaignId);
  assert.equal(audience.count, 1);
  assert.equal(audience.recipients, undefined);
  await assert.rejects(
    access.updateCampaign(member, campaignId, { status: "ACTIVE" }),
    status(403),
  );
  await assert.rejects(
    access.remove(member, campaignId, specialist),
    status(403),
  );
  await assert.rejects(
    access.assign(member, campaignId, { specialistUserId: specialist }),
    status(403),
  );
});
test("owner assignment is duplicate-safe and removal denies access", async () => {
  const { access } = fixture();
  await assert.rejects(
    access.assign(owner, campaignId, { specialistUserId: specialist }),
    status(409),
  );
  await access.remove(owner, campaignId, specialist);
  await assert.rejects(access.getCampaign(member, campaignId), status(403));
  await access.assign(owner, campaignId, { specialistUserId: specialist });
  assert.equal((await access.getCampaign(member, campaignId))._id, campaignId);
});
test("lifecycle, completion time and optimistic version", async () => {
  const { access } = fixture();
  await assert.rejects(
    access.updateCampaign(owner, campaignId, {
      status: "SCHEDULED",
      scheduledAt: "2000-01-01",
    }),
    status(400),
  );
  await access.updateCampaign(owner, campaignId, { status: "ACTIVE" });
  const completed = await access.updateCampaign(owner, campaignId, {
    status: "COMPLETED",
  });
  const completedAt = completed.completedAt;
  await access.updateCampaign(owner, campaignId, { status: "COMPLETED" });
  assert.equal(completed.completedAt, completedAt);
  await assert.rejects(
    access.updateCampaign(owner, campaignId, { status: "ACTIVE" }),
    status(400),
  );
  await assert.rejects(
    access.updateCampaign(owner, campaignId, { advisorId: other }),
    status(400),
  );
});
test("activation rejects absent audience and invalid template", async () => {
  const { access, repo } = fixture();
  repo.findAudience = async () => [];
  await assert.rejects(
    access.updateCampaign(owner, campaignId, { status: "ACTIVE" }),
    status(400),
  );
  repo.findTemplate = async () => null;
  await assert.rejects(
    access.updateCampaign(owner, campaignId, { status: "ACTIVE" }),
    status(404),
  );
});
test("schemas reject missing fields and duplicate assignments", async () => {
  await assert.rejects(new Campaign({ advisorId: advisor }).validate());
  await assert.rejects(new Template({ advisorId: advisor }).validate());
  await assert.rejects(
    new Campaign({
      advisorId: advisor,
      title: "Valid",
      strategy: "NEWSLETTER",
      channel: "EMAIL",
      assignedSpecialistIds: [specialist, specialist],
    }).validate(),
  );
});
