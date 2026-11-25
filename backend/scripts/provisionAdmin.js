import mongoose from "mongoose";

import config, {
    validateConfiguration
} from "../src/config.js";

import connectDatabase from "../src/config/database.js";

import User from "../src/modules/identity/models/User.js";

import { hashPassword } from "../src/modules/identity/passwordService.js";
import { normalizeEmail } from "../src/modules/identity/identityValidation.js";
import { ROLES } from "../src/modules/identity/identityConstants.js";
import logError from "../src/utils/logError.js";

async function main() {
    validateConfiguration();

    const name = process.env.ADMIN_NAME?.trim();
    const email = normalizeEmail(
        process.env.ADMIN_EMAIL
    );
    const password = process.env.ADMIN_PASSWORD;

    if (
        !name ||
        name.length < 2 ||
        name.length > 100 ||
        typeof password !== "string" ||
        password.length < 12 ||
        Buffer.byteLength(password) > 1024 ||
        /^replace_/i.test(password)
    ) {
        throw new Error(
            "Valid ADMIN_NAME, ADMIN_EMAIL and a non-placeholder ADMIN_PASSWORD are required."
        );
    }

    await connectDatabase(config.MONGO_URI);

    await User.init();

    const existing = await User.findOne({ email });

    if (existing) {
        throw new Error(
            "An account with this email already exists. No changes were made."
        );
    }

    await User.create({
        name,
        email,
        passwordHash: await hashPassword(password),
        role: ROLES.ADMIN,
        isActive: true
    });

    console.log("Administrator account provisioned.");
}

try {
    await main();
    await mongoose.disconnect();
} catch (error) {
    logError("Provisioning failed:", error);
    await mongoose.disconnect();
    process.exitCode = 1;
}