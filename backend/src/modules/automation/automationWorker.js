import { randomUUID } from "node:crypto";
import automationRepository from "./automationRepository.js";
import { createDefaultAdapters } from "./automationAdapters.js";
import createExecutionService from "./automationExecutionService.js";

// Lightweight polling worker for scheduled follow-ups and other delayed
// actions. It runs inside the backend process and uses the shared MongoDB
// connection, so no extra infrastructure is needed in Docker.
//
// Nothing is held in memory that matters: the schedule is the set of PENDING
// AutomationExecution documents. After a restart the worker simply finds the
// documents that are due. If several backend instances run, they can all
// poll; each execution is claimed atomically so it runs once.

export function createAutomationWorker({
    executionService = createExecutionService({
        repository: automationRepository,
        adapters: createDefaultAdapters(),
        workerId: `worker_${randomUUID().slice(0, 8)}`
    }),
    intervalMs = 30_000,
    batchSize = 25,
    logger = console
} = {}) {
    let timer = null;
    let running = false;
    let stopped = true;

    // One pass. Returns the summary, or null if a pass is already running.
    async function tick() {
        if (running) return null;

        running = true;

        try {
            return await executionService.processDue({ limit: batchSize });
        } catch (error) {
            // A failed pass must never crash the server; the next pass retries.
            logger.error("Automation worker pass failed:", error?.message);
            return null;
        } finally {
            running = false;
        }
    }

    function schedule() {
        if (stopped) return;

        // Re-armed after each pass, so passes never overlap.
        timer = setTimeout(async () => {
            await tick();
            schedule();
        }, intervalMs);

        timer.unref?.();
    }

    return {
        tick,

        start() {
            if (!stopped) return;

            stopped = false;
            schedule();
        },

        stop() {
            stopped = true;
            clearTimeout(timer);
            timer = null;
        },

        get isRunning() {
            return !stopped;
        }
    };
}

export default createAutomationWorker;
