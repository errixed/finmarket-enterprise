import mongoose from "mongoose";
import { randomUUID } from "node:crypto";

function buildTestURI(suiteName) {
    const original = process.env.MONGO_URI;

    if (!original) {
        throw new Error(
            "MONGO_URI is required for database tests."
        );
    }

    const uri = new URL(original);

    const databaseName =
        uri.pathname.replace(/^\//, "");

    if (!databaseName.includes("_test")) {
        throw new Error(
            "Tests require a database containing _test in its name."
        );
    }

    const safeName = suiteName.replace(
        /[^a-zA-Z0-9_]/g,
        "_"
    );

    const unique = randomUUID()
        .replaceAll("-", "")
        .slice(0, 12);

    uri.pathname =
        `/${databaseName}_${safeName}_${unique}`;

    return uri.toString();
}

export async function connectTestDatabase(suiteName) {
    if (mongoose.connection.readyState !== 0) {
        throw new Error(
            "A Mongoose connection is already active."
        );
    }

    const uri = buildTestURI(suiteName);

    await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000
    });

    console.log(
        `Test database connected: ${mongoose.connection.name}`
    );

    return mongoose.connection;
}

export async function disconnectTestDatabase() {
    try {
        if (mongoose.connection.readyState === 1) {
            const databaseName =
                mongoose.connection.name;

            if (!databaseName.includes("_test")) {
                throw new Error(
                    "Refusing to delete a non-test database."
                );
            }

            await mongoose.connection.dropDatabase();
        }
    } finally {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    }
}