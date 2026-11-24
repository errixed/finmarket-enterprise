import {
    test,
    before,
    after
} from "node:test";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import app from "../../src/app.js";

import {
    connectTestDatabase,
    disconnectTestDatabase
} from "../helpers/testDatabase.js";

import initializeIdentityModels from "../../src/config/initialize-identity-models.js";

let server;
let baseURL;

let advisorId;
let advisorToken;

const email =
    `advisor-${randomUUID()}@example.com`;

const password = "Password123!";

async function request(
    method,
    endpoint,
    body = undefined,
    token = null
) {
    const response = await fetch(
        `${baseURL}${endpoint}`,
        {
            method,
            headers: {
                "Content-Type": "application/json",
                ...(token
                    ? {
                        Authorization: `Bearer ${token}`
                    }
                    : {})
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

before(async () => {
    await connectTestDatabase("identity_legacy");

    await initializeIdentityModels();

    server = app.listen(0, "127.0.0.1");

    await new Promise(resolve => {
        if (server.listening) resolve();
        else server.once("listening", resolve);
    });

    baseURL =
        `http://127.0.0.1:${server.address().port}/api/v1`;

    const registration = await request(
        "POST",
        "/auth/register",
        {
            name: "John Smith",
            email,
            password,
            role: "ADVISOR",
            profile: {
                specialties: ["Retirement Planning"],
                consultationTypes: ["ONLINE"],
                bio: "Financial advisor",
                isPublic: true
            }
        }
    );

    assert.equal(registration.status, 201);

    advisorId =
        registration.body.data.advisorProfile.id;

    const login = await request(
        "POST",
        "/auth/login",
        {
            email,
            password
        }
    );

    assert.equal(login.status, 200);

    advisorToken = login.body.data.token;
});

after(async () => {
    if (server) {
        await new Promise(resolve => {
            server.close(resolve);
        });
    }

    await disconnectTestDatabase();
});

test("Health endpoint returns 200", async () => {
    const result = await request(
        "GET",
        "/health"
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.data.status, "OK");
    assert.equal(
        result.body.data.database,
        "CONNECTED"
    );
});

test("Advisor is stored with persistent ObjectId", async () => {
    assert.match(advisorId, /^[a-f0-9]{24}$/i);
});

test("Reject duplicate email registration", async () => {
    const result = await request(
        "POST",
        "/auth/register",
        {
            name: "Another User",
            email: email.toUpperCase(),
            password,
            role: "ADVISOR"
        }
    );

    assert.equal(result.status, 409);
    assert.equal(result.body.success, false);
});

test("Reject invalid email", async () => {
    const result = await request(
        "POST",
        "/auth/register",
        {
            name: "Invalid User",
            email: "invalid-email",
            password,
            role: "ADVISOR"
        }
    );

    assert.equal(result.status, 400);
});

test("Login with correct credentials returns JWT", async () => {
    const result = await request(
        "POST",
        "/auth/login",
        {
            email,
            password
        }
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(
        result.body.data.tokenType,
        "Bearer"
    );
    assert.equal(
        typeof result.body.data.token,
        "string"
    );
    assert.ok(result.body.data.token.length > 20);
});

test("Reject incorrect password", async () => {
    const result = await request(
        "POST",
        "/auth/login",
        {
            email,
            password: "WrongPassword!"
        }
    );

    assert.equal(result.status, 401);
});

test("List public advisors", async () => {
    const result = await request(
        "GET",
        "/advisors"
    );

    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.data));

    const advisor = result.body.data.find(
        item => item.id === advisorId
    );

    assert.ok(advisor);
    assert.equal(advisor.name, "John Smith");
});

test("Get advisor by ID", async () => {
    const result = await request(
        "GET",
        `/advisors/${advisorId}`
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.data.id, advisorId);
    assert.equal(
        result.body.data.name,
        "John Smith"
    );
});

test("Reject profile update without JWT", async () => {
    const result = await request(
        "PATCH",
        `/advisors/${advisorId}`,
        {
            bio: "Unauthorized update"
        }
    );

    assert.equal(result.status, 401);
});

test("Update own advisor profile", async () => {
    const result = await request(
        "PATCH",
        `/advisors/${advisorId}`,
        {
            specialties: [
                "Investment Planning",
                "Retirement Planning"
            ],
            consultationTypes: [
                "ONLINE",
                "PHONE"
            ],
            bio: "Updated financial advisor biography."
        },
        advisorToken
    );

    assert.equal(result.status, 200);

    assert.deepEqual(
        result.body.data.specialties,
        [
            "Investment Planning",
            "Retirement Planning"
        ]
    );

    assert.equal(
        result.body.data.bio,
        "Updated financial advisor biography."
    );
});

test("Retrieve updated advisor profile", async () => {
    const result = await request(
        "GET",
        `/advisors/${advisorId}`
    );

    assert.equal(result.status, 200);

    assert.equal(
        result.body.data.bio,
        "Updated financial advisor biography."
    );
});

test("Reject invalid consultation type", async () => {
    const result = await request(
        "PATCH",
        `/advisors/${advisorId}`,
        {
            consultationTypes: ["VIDEO_CALL"]
        },
        advisorToken
    );

    assert.equal(result.status, 400);
});

test("Reject modification of advisor User ID", async () => {
    const result = await request(
        "PATCH",
        `/advisors/${advisorId}`,
        {
            userId: "unauthorized-change"
        },
        advisorToken
    );

    assert.equal(result.status, 400);
});

test("Reject empty update request", async () => {
    const result = await request(
        "PATCH",
        `/advisors/${advisorId}`,
        {},
        advisorToken
    );

    assert.equal(result.status, 400);
});

test("Return 404 for nonexistent advisor", async () => {
    const result = await request(
        "GET",
        "/advisors/507f1f77bcf86cd799439011"
    );

    assert.equal(result.status, 404);
});