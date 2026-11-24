import { assignmentService } from "./assignmentService.js";

export const assignmentController = {
    async invite(req, res) {
        const result = await assignmentService.invite(
            req.body,
            req.auth
        );

        return res.status(201).json({
            success: true,
            data: result
        });
    },

    async listInvitations(req, res) {
        const results =
            await assignmentService.listInvitations(
                req.auth
            );

        return res.status(200).json({
            success: true,
            count: results.length,
            data: results
        });
    },

    async accept(req, res) {
        const result = await assignmentService.accept(
            req.params.id,
            req.auth
        );

        return res.status(200).json({
            success: true,
            data: result
        });
    },

    async decline(req, res) {
        const result = await assignmentService.decline(
            req.params.id,
            req.auth
        );

        return res.status(200).json({
            success: true,
            data: result
        });
    },

    async listAssignments(req, res) {
        const results =
            await assignmentService.listAssignments(
                req.auth
            );

        return res.status(200).json({
            success: true,
            count: results.length,
            data: results
        });
    },

    async revoke(req, res) {
        const result = await assignmentService.revoke(
            req.params.id,
            req.auth
        );

        return res.status(200).json({
            success: true,
            data: result
        });
    }
};