import { Router } from "express";
import * as controller from "./leadController.js";
import { authenticate } from "../../middleware/authMiddleware.js";
import { authorizeRoles } from "../../middleware/roleMiddleware.js";
import { ROLES } from "../identity/identityConstants.js";

const router = Router();
router.use(authenticate, authorizeRoles(ROLES.ADVISOR));
router.post("/", controller.create);
router.get("/", controller.list);
router.get("/:id", controller.get);
router.patch("/:id", controller.update);
export default router;
