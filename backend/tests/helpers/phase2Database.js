import { before, after } from "node:test";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";

// Each test file runs in its own process and receives an isolated database.
export function usePhase2Database() {
  const dbName = `finmarket_ci_${randomUUID().replaceAll("-", "")}`;
  before(async () => {
    const uri = process.env.CAMPAIGN_TEST_MONGO_URI || process.env.MONGO_URI;
    if (!uri)
      throw new Error(
        "Set CAMPAIGN_TEST_MONGO_URI or MONGO_URI for integration tests.",
      );
    await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5000 });
  });
  after(async () => {
    try {
      if (
        mongoose.connection.readyState === 1 &&
        mongoose.connection.name === dbName
      ) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      await mongoose.disconnect();
    }
  });
}
