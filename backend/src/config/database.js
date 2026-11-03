import mongoose from "mongoose";

export default async function connectDatabase(uri) {
    if (!uri) {
        throw new Error("MONGO_URI is required to connect to MongoDB.");
    }

    await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 30000
    });

    console.log(`MongoDB connected: ${mongoose.connection.name}`);
    return mongoose.connection;
}