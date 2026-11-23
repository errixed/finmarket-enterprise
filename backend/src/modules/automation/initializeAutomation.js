import AutomationRule from "./models/AutomationRule.js";
import ActivityEvent from "./models/ActivityEvent.js";
import AutomationExecution from "./models/AutomationExecution.js";
import createAutomationWorker from "./automationWorker.js";

// Called once from server.js after the MongoDB connection is open.
//
//  1. Builds the indexes. The unique indexes on ActivityEvent.eventId and on
//     AutomationExecution(eventId, automationRuleId) are what guarantee
//     duplicate prevention, so the server waits for them before serving.
//  2. Starts the scheduled-action worker (disable with
//     AUTOMATION_WORKER_ENABLED=false; interval in milliseconds with
//     AUTOMATION_WORKER_INTERVAL_MS, default 30000).

let worker = null;

export default async function initializeAutomation({
    startWorker = process.env.AUTOMATION_WORKER_ENABLED !== "false"
} = {}) {
    await Promise.all([
        AutomationRule.init(),
        ActivityEvent.init(),
        AutomationExecution.init()
    ]);

    console.log("Automation collections initialized.");

    if (startWorker && !worker) {
        const intervalMs = Number(process.env.AUTOMATION_WORKER_INTERVAL_MS);

        worker = createAutomationWorker(
            Number.isInteger(intervalMs) && intervalMs >= 1000 ? { intervalMs } : {}
        );
        worker.start();

        console.log("Automation worker started.");
    }

    return worker;
}

export function stopAutomationWorker() {
    worker?.stop();
    worker = null;
}
