import { identityService } from "./identityService.js";

export const identityController = {
    async register(req, res) {
        const result = await identityService.register(
            req.body
        );

        return res.status(201).json({
            success: true,
            data: result
        });
    },

    async login(req, res) {
        const result = await identityService.login(
            req.body
        );

        return res.status(200).json({
            success: true,
            data: result
        });
    },

    async me(req, res) {
        const result =
            await identityService.getCurrentUser(req.auth);

        return res.status(200).json({
            success: true,
            data: result
        });
    },

    async listAdvisors(req, res) {
        const advisors =
            await identityService.listAdvisors();

        return res.status(200).json({
            success: true,
            count: advisors.length,
            data: advisors
        });
    },

    async getAdvisor(req, res) {
        const advisor =
            await identityService.getAdvisor(
                req.params.id
            );

        return res.status(200).json({
            success: true,
            data: advisor
        });
    },

    async updateAdvisorProfile(req, res) {
        const advisor =
            await identityService.updateAdvisorProfile(
                req.params.id,
                req.body,
                req.auth
            );

        return res.status(200).json({
            success: true,
            data: advisor
        });
    }
};