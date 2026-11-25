import { Router } from "express";

import { authenticate } from "../../middleware/authMiddleware.js";
import { authorizeRoles } from "../../middleware/roleMiddleware.js";

import { ROLES } from "./identityConstants.js";
import { assignmentController } from "./assignmentController.js";

export const invitationRoutes = Router();
export const assignmentRoutes = Router();

invitationRoutes.use(authenticate);
assignmentRoutes.use(authenticate);

invitationRoutes.post(
    "/",
    authorizeRoles(ROLES.ADVISOR),
    assignmentController.invite
);

invitationRoutes.get(
    "/",
    authorizeRoles(
        ROLES.ADVISOR,
        ROLES.MARKETING_SPECIALIST
    ),
    assignmentController.listInvitations
);

invitationRoutes.post(
    "/:id/accept",
    authorizeRoles(ROLES.MARKETING_SPECIALIST),
    assignmentController.accept
);

invitationRoutes.post(
    "/:id/decline",
    authorizeRoles(ROLES.MARKETING_SPECIALIST),
    assignmentController.decline
);

assignmentRoutes.get(
    "/",
    authorizeRoles(
        ROLES.ADVISOR,
        ROLES.MARKETING_SPECIALIST
    ),
    assignmentController.listAssignments
);

assignmentRoutes.delete(
    "/:id",
    authorizeRoles(ROLES.ADVISOR),
    assignmentController.revoke
);