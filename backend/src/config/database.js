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