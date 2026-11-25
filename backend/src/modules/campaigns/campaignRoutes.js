import { Router } from "express";
import campaignAccess from "./campaignAccess.js";
import * as sharedAuth from "../../middleware/authMiddleware.js";
import AppError from "../../utils/AppError.js";
import { createCampaignController } from "./campaignController.js";

const unavailable = (req, res, next) =>
  next(
    new AppError(
      "Shared authentication middleware unavailable.",
      503,
      "AUTH_UNAVAILABLE",
    ),
  );
const candidate =
  sharedAuth.default ?? sharedAuth.authenticate ?? sharedAuth.requireAuth;
const authenticate = typeof candidate === "function" ? candidate : unavailable;

export function createCampaignRouter(
  service = campaignAccess,
  auth = authenticate,
) {
  const router = Router();
  const controller = createCampaignController(service);

  router.use(auth);
  router.post("/templates", controller.createTemplate);
  router.get("/templates", controller.listTemplates);
  router.get("/templates/:templateId", controller.getTemplate);
  router.post("/", controller.createCampaign);
  router.get("/", controller.listCampaigns);
  router.get("/:campaignId/audience", controller.getAudience);
  router.post("/:campaignId/specialists", controller.assign);
  router.get("/:campaignId/specialists", controller.specialists);
  router.delete("/:campaignId/specialists/:userId", controller.remove);
  router.get("/:campaignId", controller.getCampaign);
  router.patch("/:campaignId", controller.updateCampaign);

  return router;
}

export default createCampaignRouter();
