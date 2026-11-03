import mongoose from "mongoose";
import app from "./app.js";
import config from "./config.js";
import connectDatabase from "./config/database.js";

if (!Number.isInteger(config.PORT) || config.PORT < 1 || config.PORT > 65535) {
    throw new Error("Invalid server port.");
}

let server;

async function shutdown(signal) {
    console.log(`${signal} received. Shutting down...`);

    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }

    await mongoose.disconnect();
    process.exit(0);
}

try {
    await connectDatabase(config.MONGO_URI);

    server = app.listen(config.PORT, () => {
        console.log(`FinMarket-Enterprise backend running on port ${config.PORT}`);
    });

    process.once("SIGTERM", () => {
        shutdown("SIGTERM").catch(console.error);
    });

    process.once("SIGINT", () => {
        shutdown("SIGINT").catch(console.error);
    });
} catch (error) {
    console.error("Backend startup failed:", error.message);
    await mongoose.disconnect();
    process.exit(1);
}