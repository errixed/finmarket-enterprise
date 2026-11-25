import * as deliveryRepo from "../repositories/deliveryRepository.js";
import { processDeliveryInternal } from "./deliveryService.js";

let workerTimer = null;
let isBatchRunning = false;

export const processDueDeliveries = async (options = {}) => {
    if (isBatchRunning) {
        return {
            checked: 0,
            processed: 0,
            failed: 0,
            skipped: 0,
            results: [],
            alreadyRunning: true
        };
    }

    isBatchRunning = true;

    try {
        const now = options.now ? new Date(options.now) : new Date();
        const limit = options.limit ?? 20;
        const dueJobs = await deliveryRepo.findDueScheduledDeliveries(now, limit);

        let processed = 0;
        let failed = 0;
        let skipped = 0;
        const results = [];

        for (const job of dueJobs) {
            try {
                const updated = await processDeliveryInternal(job._id, {
                    ...options,
                    now
                });

                if (updated?.deliveryStatus === "SENT") {
                    processed += 1;
                } else {
                    failed += 1;
                }

                results.push({
                    jobId: job._id,
                    status: updated?.deliveryStatus ?? "UNKNOWN"
                });
            } catch (error) {
                skipped += 1;
                results.push({
                    jobId: job._id,
                    status: "SKIPPED",
                    code: error?.code ?? "PROCESSING_SKIPPED"
                });
            }
        }

        return {
            checked: dueJobs.length,
            processed,
            failed,
            skipped,
            results,
            alreadyRunning: false
        };
    } finally {
        isBatchRunning = false;
    }
};

export const startDeliveryWorker = (options = {}) => {
    if (workerTimer) {
        return workerTimer;
    }

    const intervalMs = Number.parseInt(
        options.intervalMs ?? process.env.DELIVERY_WORKER_INTERVAL_MS ?? 30_000,
        10
    );

    const safeInterval =
        Number.isFinite(intervalMs) && intervalMs >= 1_000
            ? intervalMs
            : 30_000;

    workerTimer = setInterval(() => {
        processDueDeliveries(options).catch(() => {
            // Keep polling loop resilient to transient DB/provider issues.
        });
    }, safeInterval);

    workerTimer.unref?.();

    return workerTimer;
};

export const stopDeliveryWorker = () => {
    if (workerTimer) {
        clearInterval(workerTimer);
        workerTimer = null;
    }
};

export const isDeliveryWorkerRunning = () => Boolean(workerTimer);