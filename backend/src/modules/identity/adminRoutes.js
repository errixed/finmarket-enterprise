import { Router } from "express";

import User from "./models/User.js";

import { authenticate } from "../../middleware/authMiddleware.js";
import {
    authorizePermissions
} from "../../middleware/roleMiddleware.js";

import { ROLES } from "./identityConstants.js";

import {
    validId,
    requireObject,
    allowOnly,
    fail
} from "./identityValidation.js";
import AdvisorSpecialistAssignment from "./models/AdvisorSpecialistAssignment.js";

const router = Router();

router.use(
    authenticate,
    authorizePermissions("MANAGE_PLATFORM")
);

router.get(
    "/users",
    authorizePermissions("MANAGE_USERS"),
    async (req, res) => {
        const users = await User.find()
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: users.length,
            data: users.map(user => ({
                id: String(user._id),
                name: user.name,
                email: user.email,
                role: user.role,
                isActive: user.isActive,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt
            }))
        });
    });

router.patch(
    "/users/:id/status",
    authorizePermissions("MANAGE_USERS"),
    async (req, res) => {
        const id = validId(req.params.id, "User ID");

        requireObject(req.body);

        allowOnly(req.body, ["isActive"]);

        if (typeof req.body.isActive !== "boolean") {
            fail("isActive must be a boolean.");
        }

        if (
            id === req.auth.userId &&
            req.body.isActive === false
        ) {
            fail(
                "An Administrator cannot deactivate their own account.",
                409,
                "SELF_DEACTIVATION_DENIED"
            );
        }

        const user = await User.findById(id);

        if (!user) {
            fail(
                "User not found.",
                404,
                "NOT_FOUND"
            );
        }

        user.isActive = req.body.isActive;

        await user.save();

        return res.status(200).json({
            success: true,
            data: {
                id: String(user._id),
                name: user.name,
                email: user.email,
                role: user.role,
                isActive: user.isActive
            }
        });
    });
router.get(
    "/assignments",
    authorizePermissions("REVIEW_ASSIGNMENTS"),
    async (req, res) => {
        const assignments =
            await AdvisorSpecialistAssignment.find()
                .sort({ createdAt: -1 })
                .populate({
                    path: "advisorId",
                    select: "userId",
                    populate: {
                        path: "userId",
                        select: "name email"
                    }
                })
                .populate(
                    "specialistUserId",
                    "name email role"
                );

        return res.status(200).json({
            success: true,
            count: assignments.length,
            data: assignments
        });
    });

router.delete(
    "/assignments/:id",
    authorizePermissions("REVIEW_ASSIGNMENTS"),
    async (req, res) => {

    const assignment =
        await AdvisorSpecialistAssignment.findOneAndUpdate(
            {
                _id: id,
                status: "ACCEPTED"
            },
            {
                $set: {
                    status: "REVOKED",
                    revokedAt: new Date()
                }
            },
            {
                returnDocument: "after",
                runValidators: true
            }
        );

    if (!assignment) {
        fail(
            "Accepted assignment not found.",
            404,
            "NOT_FOUND"
        );
    }

    return res.status(200).json({
        success: true,
        data: assignment
    });
});
export default router;