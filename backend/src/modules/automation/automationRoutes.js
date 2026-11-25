import { Router } from "express";
import createAutomationService from "./automationService.js";
import createAutomationController from "./automationController.js";
import { resolveAuthenticate } from "./automationAuth.js";

// Mounted in routes/index.js under /api/v1/automations.
//
// Every route requires authentication. Role and ownership rules are enforced
// in the service layer. Static paths are registered before "/:id".
export function createAutomationRouter({
    service = createAutomationService(),
    authenticate = resolveAuthenticate()
} = {}) {
    const router = Router();
    const controller = createAutomationController(service);

    router.use(authenticate);

    router.post("/", controller.createAutomation);
    router.get("/", controller.listAutomations);
    router.post("/simulate-event", controller.simulateEvent);
    router.get("/events", controller.listEvents);
    router.get("/executions", controller.listExecutions);
    router.get("/:id", controller.getAutomation);
    router.patch("/:id", controller.updateAutomation);

    return router;
}

export default createAutomationRouter();
