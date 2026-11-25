import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import errorHandler from "../../src/middleware/errorHandler.js";
import { createCampaignRouter } from "../../src/modules/campaigns/campaignRoutes.js";
import { createCampaignAccess } from "../../src/modules/campaigns/campaignAccess.js";
import AppError from "../../src/utils/AppError.js";

const fixtureAdvisorId = "507f1f77bcf86cd799439011";
const fixtureUserId = "507f1f77bcf86cd799439099";
const auth = (req, res, next) => {
    if (req.get("authorization") !== "Bearer fixture-advisor") {
        return next(new AppError("Authentication required.", 401, "UNAUTHENTICATED"));
    }
    req.user = { userId: fixtureUserId };
    next();
};
const access = service => createCampaignAccess(service, {
    findUser: async id => id === fixtureUserId ? { _id: id, role: "ADVISOR" } : null,
    findAdvisorByUser: async id => id === fixtureUserId ? { _id: fixtureAdvisorId } : null
});

test("campaign routes return the documented success envelope", async (context) => {
    const advisorId = "507f1f77bcf86cd799439011";
    const service = {
        createCampaign: async (data) => ({ _id: "campaign-1", ...data }),
        listCampaigns: async ({ status }) => [{ _id: "campaign-1", status }],
        getCampaign: async () => ({ _id: "campaign-1" }),
        updateCampaign: async ({ payload }) => ({ _id: "campaign-1", ...payload }),
        getAudience: async () => ({ campaignId: "campaign-1", count: 0, recipients: [] }),
        listTemplates: async ({ channel }) => [{ name: "Welcome", channel }],
        getTemplate: async () => ({ name: "Welcome" })
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1/campaigns", createCampaignRouter(access(service), auth));
    app.use(errorHandler);

    const server = app.listen(0);
    context.after(() => new Promise((resolve) => server.close(resolve)));
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/campaigns`;

    const createdResponse = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fixture-advisor" },
        body: JSON.stringify({
            title: "Retirement planning",
            strategy: "RETIREMENT_PLANNING",
            channel: "EMAIL"
        })
    });
    assert.equal(createdResponse.status, 201);
    assert.deepEqual(await createdResponse.json(), {
        success: true,
        data: {
            _id: "campaign-1",
            advisorId,
            title: "Retirement planning",
            strategy: "RETIREMENT_PLANNING",
            channel: "EMAIL"
        }
    });

    const templatesResponse = await fetch(
        `${baseUrl}/templates?advisorId=${advisorId}&channel=EMAIL`,
        { headers: { authorization: "Bearer fixture-advisor" } }
    );
    assert.equal(templatesResponse.status, 200);
    assert.deepEqual(await templatesResponse.json(), {
        success: true,
        data: [{ name: "Welcome", channel: "EMAIL" }]
    });

    const campaignsResponse = await fetch(
        `${baseUrl}?advisorId=${advisorId}&status=DRAFT`,
        { headers: { authorization: "Bearer fixture-advisor" } }
    );
    assert.deepEqual(await campaignsResponse.json(), {
        success: true,
        data: [{ _id: "campaign-1", status: "DRAFT" }]
    });
});
test("campaign routes reject unauthenticated requests and derive advisor ownership", async (context) => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/campaigns", createCampaignRouter(access({
        listTemplates: async ({ advisorId }) => {
            assert.equal(advisorId, fixtureAdvisorId);
            return [];
        }
    }), auth));
    app.use(errorHandler);

    const server = app.listen(0);
    context.after(() => new Promise((resolve) => server.close(resolve)));
    await once(server, "listening");

    const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/v1/campaigns/templates`
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        success: false,
        error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
            details: []
        }
    });
    const url = `http://127.0.0.1:${server.address().port}/api/v1/campaigns/templates`;
    const options = { headers: { authorization: "Bearer fixture-advisor" } };
    const own = await fetch(url, options);
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { success: true, data: [] });
    const spoofed = await fetch(`${url}?advisorId=507f1f77bcf86cd799439012`, options);
    assert.equal(spoofed.status, 403);
    assert.equal((await spoofed.json()).error.code, "FORBIDDEN");
});
