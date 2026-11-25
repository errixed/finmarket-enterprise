import { adminService } from "./adminService.js";

export const adminController = {
    async listUsers(req, res) {
        const users = await adminService.listUsers(
            req.auth
        );

        return res.status(200).json({
            success: true,
            count: users.length,
            data: users
        });
    },

    async getUser(req, res) {
        const user = await adminService.getUser(
            req.params.id,
            req.auth
        );

        return res.status(200).json({
            success: true,
            data: user
        });
    },

    async updateUserStatus(req, res) {
        const user =
            await adminService.updateUserStatus(
                req.params.id,
                req.body,
                req.auth
            );

        return res.status(200).json({
            success: true,
            data: user
        });
    },

    async listAssignments(req, res) {
        const assignments =
            await adminService.listAssignments(
                req.auth
            );

        return res.status(200).json({
            success: true,
            count: assignments.length,
            data: assignments
        });
    },

    async revokeAssignment(req, res) {
        const assignment =
            await adminService.revokeAssignment(
                req.params.id,
                req.auth
            );

        return res.status(200).json({
            success: true,
            data: assignment
        });
    },

    async listRoles(req, res) {
        const roles = adminService.listRoles(
            req.auth
        );

        return res.status(200).json({
            success: true,
            count: roles.length,
            data: roles
        });
    },

    async getUserPermissions(req, res) {
        const permissions =
            await adminService.getUserPermissions(
                req.params.id,
                req.auth
            );

        return res.status(200).json({
            success: true,
            data: permissions
        });
    }
};