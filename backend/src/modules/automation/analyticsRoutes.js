import { Router } from "express";
import createAutomationService from "./automationService.js";
import createAutomationController from "./automationController.js";
import { resolveAuthenticate } from "./automationAuth.js";

// Mounted in routes/index.js under /api/v1/analytics.
export function createAnalyticsRouter({
    service = createAutomationService(),
    authenticate = resolveAuthenticate()
} = {}) {
    const router = Router();
    const controller = createAutomationController(service);

    router.use(authenticate);

    router.get("/summary", controller.getAnalyticsSummary);

    return router;
}

export default createAnalyticsRouter();
