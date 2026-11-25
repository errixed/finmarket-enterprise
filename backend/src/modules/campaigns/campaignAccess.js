import mongoose from "mongoose";
import AppError from "../../utils/AppError.js";
import { ROLES } from "../identity/identityConstants.js";
import * as repository from "./campaignRepository.js";
import campaignService from "./campaignService.js";

const deny = () => {
  throw new AppError("Campaign access denied.", 403, "FORBIDDEN");
};
const missing = () => {
  throw new AppError("Resource not found.", 404, "NOT_FOUND");
};
const invalid = (message) => {
  throw new AppError(message, 400, "INVALID_REQUEST");
};
const id = (value) => {
  if (!mongoose.isObjectIdOrHexString(value)) invalid("Invalid ObjectId.");
  return String(value);
};
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const specialistFields = new Set([
  "title",
  "description",
  "audience",
  "templateId",
]);

// HTTP-facing service. The original service remains a trusted internal Delivery contract.
export function createCampaignAccess(
  service = campaignService,
  repo = repository,
) {
  async function principal(user) {
    if (!user)
      throw new AppError("Authentication required.", 401, "UNAUTHENTICATED");
    const userId = user.userId ?? user.id ?? user._id ?? user.sub;
    if (!mongoose.isObjectIdOrHexString(userId)) deny();
    const account = await repo.findUser(userId);
    if (
      !account ||
      ![ROLES.ADVISOR, ROLES.MARKETING_SPECIALIST].includes(account.role)
    )
      deny();
    if (account.role === ROLES.ADVISOR) {
      const profile = await repo.findAdvisorByUser(userId);
      if (!profile) deny();
      return { userId, advisorId: String(profile._id), role: account.role };
    }
    return { userId, role: account.role };
  }
  function owner(p) {
    if (p.role !== ROLES.ADVISOR) deny();
    return p.advisorId;
  }
  function assertOwner(value, advisorId) {
    if (value !== undefined && !same(value, advisorId)) deny();
  }
  async function authorized(p, campaignId) {
    const campaign = await repo.findCampaign({ campaignId: id(campaignId) });
    if (!campaign) missing();
    if (p.role === ROLES.ADVISOR) {
      if (!same(p.advisorId, campaign.advisorId)) deny();
    } else if (
      !campaign.assignedSpecialistIds?.some((value) => same(value, p.userId)) ||
      !(await repo.hasAcceptedRelationship(campaign.advisorId, p.userId))
    )
      deny();
    return campaign;
  }
  async function specialistCampaigns(p, status) {
    if (
      status &&
      !["DRAFT", "SCHEDULED", "ACTIVE", "COMPLETED", "CANCELLED"].includes(
        status,
      )
    )
      invalid("Invalid status.");
    return repo.listCampaigns({
      advisorIds: await repo.acceptedAdvisorIds(p.userId),
      specialistUserId: p.userId,
      status,
    });
  }
  function body(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      invalid("Expected JSON object.");
    return payload;
  }
  return {
    async createCampaign(user, payload) {
      const p = await principal(user);
      const advisorId = owner(p);
      body(payload);
      assertOwner(payload.advisorId, advisorId);
      return service.createCampaign({ ...payload, advisorId });
    },
    async listCampaigns(user, query) {
      const p = await principal(user);
      if (p.advisorId) {
        assertOwner(query.advisorId, p.advisorId);
        return service.listCampaigns({
          advisorId: p.advisorId,
          status: query.status,
        });
      }
      if (query.advisorId !== undefined) deny();
      return specialistCampaigns(p, query.status);
    },
    async getCampaign(user, campaignId) {
      return authorized(await principal(user), campaignId);
    },
    async updateCampaign(user, campaignId, payload) {
      const p = await principal(user);
      const campaign = await authorized(p, campaignId);
      body(payload);
      if (
        p.role === ROLES.MARKETING_SPECIALIST &&
        Object.keys(payload).some((key) => !specialistFields.has(key))
      )
        deny();
      if (
        p.role === ROLES.MARKETING_SPECIALIST &&
        payload.templateId &&
        !same(payload.templateId, campaign.templateId)
      ) {
        id(payload.templateId);
        const permitted = (await specialistCampaigns(p)).some(
          (c) =>
            same(c.advisorId, campaign.advisorId) &&
            same(c.templateId, payload.templateId),
        );
        if (!permitted) deny();
      }
      return service.updateCampaign({
        advisorId: campaign.advisorId,
        campaignId,
        payload,
        specialistUserId:
          p.role === ROLES.MARKETING_SPECIALIST ? p.userId : undefined,
      });
    },
    async getAudience(user, campaignId) {
      const p = await principal(user);
      const campaign = await authorized(p, campaignId);
      const result = await service.getAudience({
        advisorId: campaign.advisorId,
        campaignId,
      });
      return p.role === ROLES.ADVISOR
        ? result
        : { campaignId: result.campaignId, count: result.count };
    },
    async createTemplate(user, payload) {
      const p = await principal(user);
      const advisorId = owner(p);
      body(payload);
      assertOwner(payload.advisorId, advisorId);
      return service.createTemplate({ ...payload, advisorId });
    },
    async listTemplates(user, query) {
      const p = await principal(user);
      if (p.advisorId) {
        assertOwner(query.advisorId, p.advisorId);
        return service.listTemplates({
          advisorId: p.advisorId,
          channel: query.channel,
        });
      }
      if (query.advisorId !== undefined) deny();
      if (query.channel && !["EMAIL", "FACEBOOK"].includes(query.channel))
        invalid("Invalid channel.");
      const campaigns = await specialistCampaigns(p);
      const templates = await Promise.all(
        campaigns
          .filter((c) => c.templateId)
          .map((c) =>
            repo.findTemplate({
              advisorId: c.advisorId,
              templateId: c.templateId,
            }),
          ),
      );
      return [
        ...new Map(
          templates
            .filter((t) => t && (!query.channel || t.channel === query.channel))
            .map((t) => [String(t._id), t]),
        ).values(),
      ];
    },
    async getTemplate(user, templateId) {
      const p = await principal(user);
      id(templateId);
      if (p.advisorId)
        return service.getTemplate({ advisorId: p.advisorId, templateId });
      const campaign = (await specialistCampaigns(p)).find((c) =>
        same(c.templateId, templateId),
      );
      if (!campaign) deny();
      return service.getTemplate({ advisorId: campaign.advisorId, templateId });
    },
    async assign(user, campaignId, payload) {
      const p = await principal(user);
      owner(p);
      const campaign = await authorized(p, campaignId);
      body(payload);
      if (Object.keys(payload).some((key) => key !== "specialistUserId"))
        invalid("Unsupported assignment field.");
      const userId = id(payload.specialistUserId);
      const specialist = await repo.findUser(userId);
      if (
        specialist?.role !== ROLES.MARKETING_SPECIALIST ||
        !(await repo.hasAcceptedRelationship(campaign.advisorId, userId))
      )
        deny();
      const updated = await repo.changeAssignment({
        advisorId: p.advisorId,
        campaignId,
        userId,
        add: true,
      });
      if (!updated)
        throw new AppError(
          "Specialist already assigned or campaign changed.",
          409,
          "ASSIGNMENT_CONFLICT",
        );
      return {
        campaignId: updated._id,
        assignedSpecialistIds: updated.assignedSpecialistIds,
      };
    },
    async specialists(user, campaignId) {
      const p = await principal(user);
      owner(p);
      const campaign = await authorized(p, campaignId);
      return Promise.all(
        (campaign.assignedSpecialistIds ?? []).map(async (userId) => {
          const account = await repo.findUser(userId);
          return { userId, name: account?.name ?? null };
        }),
      );
    },
    async remove(user, campaignId, specialistId) {
      const p = await principal(user);
      owner(p);
      await authorized(p, campaignId);
      const updated = await repo.changeAssignment({
        advisorId: p.advisorId,
        campaignId,
        userId: id(specialistId),
        add: false,
      });
      if (!updated) missing();
      return {
        campaignId: updated._id,
        assignedSpecialistIds: updated.assignedSpecialistIds,
      };
    },
  };
}
export default createCampaignAccess();
