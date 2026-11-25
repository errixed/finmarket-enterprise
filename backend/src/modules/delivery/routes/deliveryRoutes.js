import express from "express";
import * as deliveryController from "../controllers/deliveryController.js";
import {
    authenticateDelivery,
    authorizeDeliveryRoles
} from "../middleware/deliveryAuth.js";

const router = express.Router();

router.use(authenticateDelivery);

router.post(
    "/",
    authorizeDeliveryRoles("ADVISOR", "MARKETING_SPECIALIST"),
    deliveryController.queueDelivery
);

router.get(
    "/",
    authorizeDeliveryRoles("ADVISOR", "MARKETING_SPECIALIST", "ADMIN"),
    deliveryController.getDeliveryHistory
);

router.get(
    "/:id",
    authorizeDeliveryRoles("ADVISOR", "MARKETING_SPECIALIST", "ADMIN"),
    deliveryController.getDeliveryById
);

router.post(
    "/:id/process",
    authorizeDeliveryRoles("ADVISOR", "MARKETING_SPECIALIST"),
    deliveryController.processDelivery
);

router.post(
    "/:id/retry",
    authorizeDeliveryRoles("ADVISOR", "MARKETING_SPECIALIST"),
    deliveryController.retryDelivery
);

export default router;