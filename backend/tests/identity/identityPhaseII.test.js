import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

import app from "../../src/app.js";
import config from "../../src/config.js";

import initializeIdentityModels from "../../src/config/initialize-identity-models.js";

import User from "../../src/modules/identity/models/User.js";
import AdvisorProfile from "../../src/modules/identity/models/AdvisorProfile.js";

import { hashPassword } from "../../src/modules/identity/passwordService.js";
import {
    authorizeRoles,
    authorizePermissions,
    hasRolePermission
} from "../../src/middleware/roleMiddleware.js";

let server;
let baseURL;

const suffix = randomUUID().replaceAll("-", "");

const advisorEmail = `advisor-${suffix}@example.com`;
const specialistEmail = `specialist-${suffix}@example.com`;

let advisorId;
let advisorUserId;
let specialistUserId;

let advisorToken;
let specialistToken;
let adminToken;

let invitationId;
let acceptedAssignmentId;

async function request(method, path, body, token = null) {
    const response = await fetch(`${baseURL}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token
                ? { Authorization: `Bearer ${token}` }
                : {})
        },
        body: body === undefined
            ? undefined
            : JSON.stringify(body)
    });

    return {
        status: response.status,
        body: await response.json()
    };
}

before(async () => {
    if (!process.env.MONGO_URI) {
        throw new Error(
            "MONGO_URI must point to a disposable test database."
        );
    }

    const uri = new URL(process.env.MONGO_URI);

    if (!uri.pathname.includes("_test")) {
        throw new Error(
            "Refusing to run tests outside a _test database."
        );
    }

    if (!config.JWT_SECRET) {
        throw new Error("JWT_SECRET is required.");
    }

    await mongoose.connect(process.env.MONGO_URI);

    await initializeIdentityModels();

    server = app.listen(0);

    await new Promise(resolve => {
        if (server.listening) resolve();
        else server.once("listening", resolve);
    });

    baseURL =
        `http://127.0.0.1:${server.address().port}/api/v1`;

    const admin = await User.create({
        name: "Test Administrator",
        email: `admin-${suffix}@example.com`,
        passwordHash: await hashPassword("AdminPassword123!"),
        role: "ADMIN"
    });

    const login = await request("POST", "/auth/login", {
        email: admin.email,
        password: "AdminPassword123!"
    });

    assert.equal(login.status, 200);

    adminToken = login.body.data.token;
});

after(async () => {
    if (server) {
        await new Promise(resolve => server.close(resolve));
    }

    if (mongoose.connection.readyState === 1) {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
    }
});

test("Advisor registration persists User and AdvisorProfile", async () => {
    const result = await request(
        "POST",
        "/auth/register",
        {
            name: "Test Advisor",
            email: advisorEmail,
            password: "Password123!",
            role: "ADVISOR",
            profile: {
                specialties: ["Retirement"],
                consultationTypes: ["ONLINE"],
                isPublic: true
            }
        }
    );

    assert.equal(result.status, 201);

    advisorId = result.body.data.advisorProfile.id;
    advisorUserId = result.body.data.user.id;

    assert.notEqual(advisorId, advisorUserId);

    const profile = await AdvisorProfile.findById(
        advisorId
    );

    assert.equal(
        String(profile.userId),
        advisorUserId
    );

    assert.equal(
        result.body.data.user.passwordHash,
        undefined
    );
});

test("Specialist registration does not create AdvisorProfile", async () => {
    const result = await request(
        "POST",
        "/auth/register",
        {
            name: "Test Specialist",
            email: specialistEmail,
            password: "Password123!",
            role: "MARKETING_SPECIALIST"
        }
    );

    assert.equal(result.status, 201);

    specialistUserId = result.body.data.user.id;

    assert.equal(
        result.body.data.advisorProfile,
        null
    );

    const profile = await AdvisorProfile.findOne({
        userId: specialistUserId
    });

    assert.equal(profile, null);
});

test("Duplicate email is rejected", async () => {
    const result = await request(
        "POST",
        "/auth/register",
        {
            name: "Duplicate Advisor",
            email: advisorEmail.toUpperCase(),
            password: "Password123!",
            role: "ADVISOR"
        }
    );

    assert.equal(result.status, 409);
});

test("Public ADMIN registration is rejected", async () => {
    const result = await request(
        "POST",
        "/auth/register",
        {
            name: "Illegal Admin",
            email: `illegal-${suffix}@example.com`,
            password: "Password123!",
            role: "ADMIN"
        }
    );

    assert.equal(result.status, 400);
});

test("Privileged registration fields are rejected", async () => {
    const result = await request(
        "POST",
        "/auth/register",
        {
            name: "Privileged User",
            email: `privileged-${suffix}@example.com`,
            password: "Password123!",
            role: "ADVISOR",
            isActive: true
        }
    );

    assert.equal(result.status, 400);
});

test("Login returns signed JWT", async () => {
    const advisor = await request(
        "POST",
        "/auth/login",
        {
            email: advisorEmail,
            password: "Password123!"
        }
    );

    assert.equal(advisor.status, 200);

    advisorToken = advisor.body.data.token;

    const decoded = jwt.verify(
        advisorToken,
        config.JWT_SECRET,
        {
            algorithms: ["HS256"],
            issuer: config.JWT_ISSUER,
            audience: config.JWT_AUDIENCE
        }
    );

    assert.equal(decoded.sub, advisorUserId);
    assert.equal(decoded.role, "ADVISOR");

    assert.ok(decoded.exp > decoded.iat);

    assert.equal(
        advisor.body.data.user.passwordHash,
        undefined
    );

    const specialist = await request(
        "POST",
        "/auth/login",
        {
            email: specialistEmail,
            password: "Password123!"
        }
    );

    assert.equal(specialist.status, 200);

    specialistToken = specialist.body.data.token;
});

test("Incorrect password is rejected", async () => {
    const result = await request(
        "POST",
        "/auth/login",
        {
            email: advisorEmail,
            password: "IncorrectPassword"
        }
    );

    assert.equal(result.status, 401);
});

test("Missing JWT is rejected", async () => {
    const result = await request(
        "GET",
        "/auth/me"
    );

    assert.equal(result.status, 401);
});

test("Invalid JWT is rejected", async () => {
    const result = await request(
        "GET",
        "/auth/me",
        undefined,
        "invalid.token.value"
    );

    assert.equal(result.status, 401);
});

test("Expired JWT is rejected", async () => {
    const token = jwt.sign(
        { role: "ADVISOR" },
        config.JWT_SECRET,
        {
            algorithm: "HS256",
            subject: advisorUserId,
            expiresIn: -1,
            issuer: config.JWT_ISSUER,
            audience: config.JWT_AUDIENCE
        }
    );

    const result = await request(
        "GET",
        "/auth/me",
        undefined,
        token
    );

    assert.equal(result.status, 401);
});

test("Authenticated Advisor context uses AdvisorProfile ID", async () => {
    const result = await request(
        "GET",
        "/auth/me",
        undefined,
        advisorToken
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.data.advisorId, advisorId);
});

test("Advisor can update own profile", async () => {
    const result = await request(
        "PATCH",
        `/advisors/${advisorId}`,
        {
            bio: "Updated advisor biography."
        },
        advisorToken
    );

    assert.equal(result.status, 200);
    assert.equal(
        result.body.data.bio,
        "Updated advisor biography."
    );
});

test("Specialist cannot update Advisor profile", async () => {
    const result = await request(
        "PATCH",
        `/advisors/${advisorId}`,
        {
            bio: "Unauthorized update"
        },
        specialistToken
    );

    assert.equal(result.status, 403);
});

test("Advisor can invite Marketing Specialist", async () => {
    const result = await request(
        "POST",
        "/advisor-invitations",
        {
            specialistUserId
        },
        advisorToken
    );

    assert.equal(result.status, 201);

    invitationId = result.body.data.id;

    assert.equal(
        result.body.data.status,
        "PENDING"
    );
});

test("Duplicate invitation is rejected", async () => {
    const result = await request(
        "POST",
        "/advisor-invitations",
        {
            specialistUserId
        },
        advisorToken
    );

    assert.equal(result.status, 409);
});

test("Specialist can list their pending invitations", async () => {
    const result = await request(
        "GET",
        "/advisor-invitations",
        undefined,
        specialistToken
    );

    assert.equal(result.status, 200);

    assert.ok(
        result.body.data.some(
            item => item.id === invitationId
        )
    );
});

test("Only invited specialist can accept", async () => {
    const result = await request(
        "POST",
        `/advisor-invitations/${invitationId}/accept`,
        {},
        advisorToken
    );

    assert.equal(result.status, 403);
});

test("Invited specialist accepts invitation", async () => {
    const result = await request(
        "POST",
        `/advisor-invitations/${invitationId}/accept`,
        {},
        specialistToken
    );

    assert.equal(result.status, 200);
    assert.equal(
        result.body.data.status,
        "ACCEPTED"
    );

    acceptedAssignmentId = result.body.data.id;
});

test("Accepted assignment appears in Advisor list", async () => {
    const result = await request(
        "GET",
        "/advisor-assignments",
        undefined,
        advisorToken
    );

    assert.equal(result.status, 200);

    assert.ok(
        result.body.data.some(
            item => item.id === acceptedAssignmentId
        )
    );
});

test("Advisor revokes accepted assignment", async () => {
    const result = await request(
        "DELETE",
        `/advisor-assignments/${acceptedAssignmentId}`,
        undefined,
        advisorToken
    );

    assert.equal(result.status, 200);
    assert.equal(
        result.body.data.status,
        "REVOKED"
    );
});

test("Revoked assignment disappears from accepted list", async () => {
    const result = await request(
        "GET",
        "/advisor-assignments",
        undefined,
        specialistToken
    );

    assert.equal(result.status, 200);

    assert.ok(
        !result.body.data.some(
            item => item.id === acceptedAssignmentId
        )
    );
});


test("Administrator cannot deactivate own account", async () => {
    const me = await request(
        "GET",
        "/auth/me",
        undefined,
        adminToken
    );

    const result = await request(
        "PATCH",
        `/admin/users/${me.body.data.user.id}/status`,
        {
            isActive: false
        },
        adminToken
    );

    assert.equal(result.status, 409);
});
test("Advisor cannot modify another Advisor's profile", async () => {
    const other = await request(
        "POST",
        "/auth/register",
        {
            name: "Other Advisor",
            email: `other-${suffix}@example.com`,
            password: "Password123!",
            role: "ADVISOR"
        }
    );

    assert.equal(other.status, 201);

    const otherAdvisorId =
        other.body.data.advisorProfile.id;

    const result = await request(
        "PATCH",
        `/advisors/${otherAdvisorId}`,
        {
            bio: "Unauthorized modification"
        },
        advisorToken
    );

    assert.equal(result.status, 403);
});
test("Unrelated specialist cannot accept another invitation", async () => {
    const invitedEmail =
        `invited-${randomUUID()}@example.com`;

    const unrelatedEmail =
        `unrelated-${randomUUID()}@example.com`;

    const invitedRegistration = await request(
        "POST",
        "/auth/register",
        {
            name: "Invited Specialist",
            email: invitedEmail,
            password: "Password123!",
            role: "MARKETING_SPECIALIST"
        }
    );

    assert.equal(invitedRegistration.status, 201);

    const invitedUserId =
        invitedRegistration.body.data.user.id;

    const unrelatedRegistration = await request(
        "POST",
        "/auth/register",
        {
            name: "Unrelated Specialist",
            email: unrelatedEmail,
            password: "Password123!",
            role: "MARKETING_SPECIALIST"
        }
    );

    assert.equal(unrelatedRegistration.status, 201);

    const unrelatedLogin = await request(
        "POST",
        "/auth/login",
        {
            email: unrelatedEmail,
            password: "Password123!"
        }
    );

    assert.equal(unrelatedLogin.status, 200);

    const invitation = await request(
        "POST",
        "/advisor-invitations",
        {
            specialistUserId: invitedUserId
        },
        advisorToken
    );

    assert.equal(invitation.status, 201);

    const result = await request(
        "POST",
        `/advisor-invitations/${invitation.body.data.id}/accept`,
        {},
        unrelatedLogin.body.data.token
    );

    assert.equal(result.status, 403);
});
test("Specialist can decline an invitation", async () => {
    const email =
        `decline-${randomUUID()}@example.com`;

    const registration = await request(
        "POST",
        "/auth/register",
        {
            name: "Declining Specialist",
            email,
            password: "Password123!",
            role: "MARKETING_SPECIALIST"
        }
    );

    assert.equal(registration.status, 201);

    const login = await request(
        "POST",
        "/auth/login",
        {
            email,
            password: "Password123!"
        }
    );

    assert.equal(login.status, 200);

    const token = login.body.data.token;

    const invitation = await request(
        "POST",
        "/advisor-invitations",
        {
            specialistUserId:
                registration.body.data.user.id
        },
        advisorToken
    );

    assert.equal(invitation.status, 201);

    const result = await request(
        "POST",
        `/advisor-invitations/${invitation.body.data.id}/decline`,
        {},
        token
    );

    assert.equal(result.status, 200);
    assert.equal(
        result.body.data.status,
        "DECLINED"
    );
});
test("Role restrictions protect administrative endpoints", async () => {
    const advisorResult = await request(
        "GET",
        "/admin/users",
        undefined,
        advisorToken
    );

    assert.equal(advisorResult.status, 403);

    const email =
        `role-test-${randomUUID()}@example.com`;

    const registration = await request(
        "POST",
        "/auth/register",
        {
            name: "Role Test Specialist",
            email,
            password: "Password123!",
            role: "MARKETING_SPECIALIST"
        }
    );

    assert.equal(registration.status, 201);

    const login = await request(
        "POST",
        "/auth/login",
        {
            email,
            password: "Password123!"
        }
    );

    assert.equal(login.status, 200);

    const specialistResult = await request(
        "GET",
        "/admin/users",
        undefined,
        login.body.data.token
    );

    assert.equal(specialistResult.status, 403);
});
test("Administrator can review relationships", async () => {
    const result = await request(
        "GET",
        "/admin/assignments",
        undefined,
        adminToken
    );

    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.data));
});
test("Inactive user cannot access protected routes", async () => {
    const deactivate = await request(
        "PATCH",
        `/admin/users/${specialistUserId}/status`,
        {
            isActive: false
        },
        adminToken
    );

    assert.equal(deactivate.status, 200);

    const result = await request(
        "GET",
        "/auth/me",
        undefined,
        specialistToken
    );

    assert.equal(result.status, 401);
});

test("M1: role permission checks are explicit", () => {
    assert.equal(
        hasRolePermission("ADMIN", "MANAGE_USERS"),
        true
    );

    assert.equal(
        hasRolePermission("ADVISOR", "MANAGE_USERS"),
        false
    );

    assert.equal(
        hasRolePermission(
            "MARKETING_SPECIALIST",
            "VIEW_ASSIGNED_CAMPAIGNS"
        ),
        true
    );

    assert.equal(
        hasRolePermission("ADMIN", "MANAGE_OWN_LEADS"),
        false
    );

    assert.equal(
        hasRolePermission("UNKNOWN", "MANAGE_USERS"),
        false
    );
});

test("M1: permission middleware requires authentication", () => {
    const middleware =
        authorizePermissions("MANAGE_USERS");

    let receivedError = null;

    middleware({}, {}, error => {
        receivedError = error;
    });

    assert.equal(receivedError.statusCode, 401);
});

test("M1: permission middleware denies unauthorized roles", () => {
    const middleware =
        authorizePermissions("MANAGE_USERS");

    let receivedError = null;

    middleware(
        {
            auth: {
                userId: new mongoose.Types.ObjectId().toString(),
                role: "ADVISOR"
            }
        },
        {},
        error => {
            receivedError = error;
        }
    );

    assert.equal(receivedError.statusCode, 403);
});

test("M1: permission middleware allows permitted roles", () => {
    const middleware =
        authorizePermissions(
            "MANAGE_USERS",
            "MANAGE_PLATFORM"
        );

    let receivedError = null;
    let nextCalled = false;

    middleware(
        {
            auth: {
                userId: new mongoose.Types.ObjectId().toString(),
                role: "ADMIN"
            }
        },
        {},
        error => {
            if (error) {
                receivedError = error;
            } else {
                nextCalled = true;
            }
        }
    );

    assert.equal(receivedError, null);
    assert.equal(nextCalled, true);
});

test("M1: permission middleware rejects empty permission requirements", () => {
    assert.throws(
        () => authorizePermissions(),
        TypeError
    );
});

test("M1: role middleware still supports existing callers", () => {
    const middleware = authorizeRoles("ADVISOR");

    let nextCalled = false;

    middleware(
        {
            auth: {
                role: "ADVISOR"
            }
        },
        {},
        error => {
            assert.equal(error, undefined);
            nextCalled = true;
        }
    );

    assert.equal(nextCalled, true);
});

test("M1: inactive Advisors are hidden from public directory and lookup", async () => {
    const email =
        `visibility-${randomUUID()}@example.com`;

    const registration = await request(
        "POST",
        "/auth/register",
        {
            name: "Visibility Test Advisor",
            email,
            password: "Password123!",
            role: "ADVISOR",
            profile: {
                specialties: ["Investment Planning"],
                consultationTypes: ["ONLINE"],
                bio: "Public visibility test.",
                isPublic: true
            }
        }
    );

    assert.equal(registration.status, 201);

    const userId =
        registration.body.data.user.id;

    const profileId =
        registration.body.data.advisorProfile.id;

    const beforeList = await request(
        "GET",
        "/advisors"
    );

    assert.equal(beforeList.status, 200);

    assert.ok(
        beforeList.body.data.some(
            advisor => advisor.id === profileId
        )
    );

    const beforeLookup = await request(
        "GET",
        `/advisors/${profileId}`
    );

    assert.equal(beforeLookup.status, 200);

    const deactivation = await request(
        "PATCH",
        `/admin/users/${userId}/status`,
        {
            isActive: false
        },
        adminToken
    );

    assert.equal(deactivation.status, 200);

    const afterList = await request(
        "GET",
        "/advisors"
    );

    assert.equal(afterList.status, 200);

    assert.ok(
        !afterList.body.data.some(
            advisor => advisor.id === profileId
        )
    );

    const afterLookup = await request(
        "GET",
        `/advisors/${profileId}`
    );

    assert.equal(afterLookup.status, 404);

    const storedProfile =
        await AdvisorProfile.findById(profileId);

    assert.ok(storedProfile);
    assert.equal(storedProfile.isPublic, true);
});
