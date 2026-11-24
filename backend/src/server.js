import mongoose from "mongoose";
import app from "./app.js";
import config, { validateConfiguration } from "./config.js";
import connectDatabase from "./config/database.js";
import initializeIdentityModels from "./config/initialize-identity-models.js";
import initializeAutomation, {
    stopAutomationWorker
} from "./modules/automation/initializeAutomation.js";

let server;
let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;

    console.log(`${signal} received. Shutting down...`);

    const forceExit = setTimeout(() => {
        console.error("Shutdown timeout.");
        process.exit(1);
    }, 10000);

    forceExit.unref();

    try {
        await stopAutomationWorker();

        if (server) {
            await new Promise((resolve, reject) => {
                server.close(error => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        }

        await mongoose.disconnect();

        clearTimeout(forceExit);
        process.exit(0);
    } catch (error) {
        console.error("Shutdown failed:", error.message);
        process.exit(1);
    }
}

try {
    validateConfiguration();

    await connectDatabase(config.MONGO_URI);

    await initializeIdentityModels();

    await initializeAutomation();

    server = app.listen(config.PORT, () => {
        console.log(
            `FinMarket-Enterprise backend running on port ${config.PORT}`
        );
    });

    process.once("SIGTERM", () => {
        void shutdown("SIGTERM");
    });

    process.once("SIGINT", () => {
        void shutdown("SIGINT");
    });
} catch (error) {
    console.error("Backend startup failed:", error.message);

    await mongoose.disconnect();

    process.exit(1);
}