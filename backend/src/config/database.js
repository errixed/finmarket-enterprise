import mongoose from "mongoose";

export default async function connectDatabase(uri) {
    if (!uri || typeof uri !== "string") {
        throw new Error("MONGO_URI is required.");
    }

    await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000,
        maxPoolSize: 20,
        retryWrites: true
    });

    console.log(
        `MongoDB connected: ${mongoose.connection.name}`
    );

    return mongoose.connection;
}

export async function isDatabaseHealthy() {
    if (
        mongoose.connection.readyState !== 1 ||
        !mongoose.connection.db
    ) {
        return false;
    }

    try {
        const result =
            await mongoose.connection.db.command(
                { ping: 1 },
                { timeoutMS: 2000 }
            );

        return result.ok === 1;
    } catch {
        return false;
    }
}