import { Router } from "express";

import { adminController } from "./adminController.js";

import {
    authenticate
} from "../../middleware/authMiddleware.js";

import {
    authorizePermissions
} from "../../middleware/roleMiddleware.js";

const router = Router();

router.use(
    authenticate,
    authorizePermissions("MANAGE_PLATFORM")
);

router.get(
    "/users",
    authorizePermissions("MANAGE_USERS"),
    adminController.listUsers
);

router.get(
    "/users/:id",
    authorizePermissions("MANAGE_USERS"),
    adminController.getUser
);

router.patch(
    "/users/:id/status",
    authorizePermissions("MANAGE_USERS"),
    adminController.updateUserStatus
);

router.get(
    "/assignments",
    authorizePermissions("REVIEW_ASSIGNMENTS"),
    adminController.listAssignments
);

router.delete(
    "/assignments/:id",
    authorizePermissions("REVIEW_ASSIGNMENTS"),
    adminController.revokeAssignment
);

router.get(
    "/roles",
    authorizePermissions("MANAGE_PERMISSIONS"),
    adminController.listRoles
);

router.get(
    "/users/:id/permissions",
    authorizePermissions("MANAGE_PERMISSIONS"),
    adminController.getUserPermissions
);

export default router;