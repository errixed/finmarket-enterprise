import mongoose from "mongoose";
import { Router } from "express";

import {
    authRoutes,
    advisorRoutes
} from "../modules/identity/identityRoutes.js";

import {
    invitationRoutes,
    assignmentRoutes
} from "../modules/identity/assignmentRoutes.js";

import adminRoutes from "../modules/identity/adminRoutes.js";

import leadRoutes from "../modules/leads/leadRoutes.js";
import campaignRoutes from "../modules/campaigns/campaignRoutes.js";
import deliveryRoutes from "../modules/delivery/routes/deliveryRoutes.js";
import automationRoutes from "../modules/automation/automationRoutes.js";
import analyticsRoutes from "../modules/automation/analyticsRoutes.js";

const router = Router();

router.get("/health", (req, res) => {
    const databaseConnected =
        mongoose.connection.readyState === 1;

    return res.status(
        databaseConnected ? 200 : 503
    ).json({
        success: databaseConnected,
        data: {
            status: databaseConnected
                ? "OK"
                : "UNAVAILABLE",
            application: "FinMarket-Enterprise",
            database: databaseConnected
                ? "CONNECTED"
                : "DISCONNECTED",
            timestamp: new Date().toISOString()
        }
    });
});

router.use("/auth", authRoutes);
router.use("/advisors", advisorRoutes);

router.use(
    "/advisor-invitations",
    invitationRoutes
);

router.use(
    "/advisor-assignments",
    assignmentRoutes
);

router.use("/admin", adminRoutes);

router.use("/leads", leadRoutes);
router.use("/campaigns", campaignRoutes);
router.use("/deliveries", deliveryRoutes);
router.use("/automations", automationRoutes);
router.use("/analytics", analyticsRoutes);

export default router;