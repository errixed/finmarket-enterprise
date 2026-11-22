import { Router } from "express";

import { identityController } from "./identityController.js";

import { authenticate } from "../../middleware/authMiddleware.js";
import {
    authorizePermissions
} from "../../middleware/roleMiddleware.js";

import { ROLES } from "./identityConstants.js";

export const authRoutes = Router();
export const advisorRoutes = Router();

authRoutes.post(
    "/register",
    identityController.register
);

authRoutes.post(
    "/login",
    identityController.login
);

authRoutes.get(
    "/me",
    authenticate,
    identityController.me
);

advisorRoutes.get(
    "/",
    identityController.listAdvisors
);

advisorRoutes.get(
    "/:id",
    identityController.getAdvisor
);

advisorRoutes.patch(
    "/:id",
    authenticate,
    authorizePermissions("MANAGE_OWN_PROFILE"),
    identityController.updateAdvisorProfile
);