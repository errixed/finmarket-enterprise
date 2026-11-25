import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import mongoose from "mongoose";

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import app from "../../src/app.js";

import connectDatabase, {
    isDatabaseHealthy
} from "../../src/config/database.js";

import initializeIdentityModels
    from "../../src/config/initialize-identity-models.js";

import User
    from "../../src/modules/identity/models/User.js";

import AdvisorProfile
    from "../../src/modules/identity/models/AdvisorProfile.js";

import {
    connectTestDatabase,
    disconnectTestDatabase
} from "../helpers/testDatabase.js";

let server;
let baseURL;
let databaseName;

const backendPath = fileURLToPath(
    new URL("../../", import.meta.url)
);

before(async () => {
    await connectTestDatabase("infrastructure");

    databaseName = mongoose.connection.name;

    await initializeIdentityModels();

    server = app.listen(0);

    await new Promise(resolve => {
        if (server.listening) {
            resolve();
        } else {
            server.once("listening", resolve);
        }
    });

    baseURL =
        `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
    try {
        if (server) {
            await new Promise(resolve =>
                server.close(resolve)
            );
        }
    } finally {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(
                process.env.MONGO_URI,
                { dbName: databaseName }
            );
        }

        await disconnectTestDatabase();
    }
});

async function request(method, path, body) {
    const response = await fetch(
        `${baseURL}${path}`,
        {
            method,
            headers: {
                "Content-Type": "application/json"
            },
            body: body === undefined
                ? undefined
                : JSON.stringify(body)
        }
    );

    return {
        status: response.status,
        body: await response.json()
    };
}

test("M1 infrastructure: shared MongoDB connection is healthy", async () => {
    assert.equal(
        mongoose.connection.readyState,
        1
    );

    assert.equal(
        await isDatabaseHealthy(),
        true
    );
});

test("M1 infrastructure: health endpoint reports database availability", async () => {
    const result = await request(
        "GET",
        "/health"
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);

    assert.equal(
        result.body.data.database,
        "CONNECTED"
    );
});

test("M1 infrastructure: missing MongoDB URI is rejected", async () => {
    await assert.rejects(
        () => connectDatabase(null),
        /MONGO_URI is required/
    );
});

test("M1 infrastructure: server configuration rejects missing MongoDB URI", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `
                import {
                    validateConfiguration
                } from "./src/config.js";

                validateConfiguration();
            `
        ],
        {
            cwd: backendPath,
            env: {
                ...process.env,
                MONGO_URI: "",
                JWT_SECRET: "test-only-secret-at-least-32-characters"
            },
            encoding: "utf8",
            timeout: 10000
        }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MONGO_URI is required/);
});

test("M1 infrastructure: invalid JWT secret is rejected", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `
                import {
                    validateConfiguration
                } from "./src/config.js";

                validateConfiguration();
            `
        ],
        {
            cwd: backendPath,
            env: {
                ...process.env,
                JWT_SECRET: "short"
            },
            encoding: "utf8",
            timeout: 10000
        }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JWT_SECRET/);
});

test("M1 infrastructure: invalid MongoDB URI prevents startup", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `
                import connectDatabase
                    from "./src/config/database.js";

                await connectDatabase("invalid-mongodb-uri");
            `
        ],
        {
            cwd: backendPath,
            encoding: "utf8",
            timeout: 10000
        }
    );

    assert.equal(result.status, 1);
});

test("M1 infrastructure: users survive database reconnection", async () => {
    const email =
        `persistent-${randomUUID()}@example.com`;

    const registration = await request(
        "POST",
        "/auth/register",
        {
            name: "Persistent Advisor",
            email,
            password: "Password123!",
            role: "ADVISOR"
        }
    );

    assert.equal(registration.status, 201);

    const userId =
        registration.body.data.user.id;

    const advisorId =
        registration.body.data.advisorProfile.id;

    await mongoose.disconnect();

    try {
        const unavailable = await request(
            "GET",
            "/health"
        );

        assert.equal(unavailable.status, 503);

        assert.equal(
            unavailable.body.data.database,
            "DISCONNECTED"
        );

        assert.equal(
            await isDatabaseHealthy(),
            false
        );
    } finally {
        await mongoose.connect(
            process.env.MONGO_URI,
            {
                dbName: databaseName
            }
        );
    }

    const user = await User.findById(userId);

    const advisor =
        await AdvisorProfile.findById(advisorId);

    assert.ok(user);
    assert.ok(advisor);

    assert.equal(
        String(advisor.userId),
        userId
    );

    const login = await request(
        "POST",
        "/auth/login",
        {
            email,
            password: "Password123!"
        }
    );

    assert.equal(login.status, 200);

    const healthy = await request(
        "GET",
        "/health"
    );

    assert.equal(healthy.status, 200);
});

test("M1 infrastructure: controlled administrator provisioning", async () => {
    const email =
        `provision-${randomUUID()}@example.com`;

    const uri = new URL(process.env.MONGO_URI);

    uri.pathname = `/${databaseName}`;

    const env = {
        ...process.env,
        MONGO_URI: uri.toString(),
        ADMIN_NAME: "Provisioned Test Administrator",
        ADMIN_EMAIL: email,
        ADMIN_PASSWORD: "TestAdminPassword123!"
    };

    const result = spawnSync(
        process.execPath,
        ["scripts/provisionAdmin.js"],
        {
            cwd: backendPath,
            env,
            encoding: "utf8",
            timeout: 30000
        }
    );

    assert.equal(
        result.status,
        0,
        result.stderr
    );

    const user = await User.findOne({ email })
        .select("+passwordHash");

    assert.ok(user);
    assert.equal(user.role, "ADMIN");

    assert.notEqual(
        user.passwordHash,
        env.ADMIN_PASSWORD
    );

    const profile =
        await AdvisorProfile.findOne({
            userId: user._id
        });

    assert.equal(profile, null);

    const duplicate = spawnSync(
        process.execPath,
        ["scripts/provisionAdmin.js"],
        {
            cwd: backendPath,
            env,
            encoding: "utf8",
            timeout: 30000
        }
    );

    assert.notEqual(duplicate.status, 0);

    assert.equal(
        await User.countDocuments({ email }),
        1
    );
});