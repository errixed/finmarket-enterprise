import AppError from "../../utils/AppError.js";
import { ROLES } from "../identity/identityConstants.js";

// Authorization policy for Automation & Analytics.
//
// Authentication itself (JWT verification) belongs to the shared middleware
// owned by Member 1. This file only reads the authenticated context it
// produces ({ userId, role, advisorId }) and decides what that user may do.
//
//   ADVISOR               full access to their own rules, events, executions
//                         and analytics; the only role that creates rules or
//                         simulates events.
//   MARKETING_SPECIALIST  read access to Campaign-related automation data,
//                         and only when BOTH an accepted advisor-specialist
//                         relationship AND a campaign assignment exist. May
//                         switch a rule on/off only if its owner explicitly
//                         allowed it (allowSpecialistToggle).
//   ADMIN                 read-only oversight of all automation data. No
//                         create, update or simulate. This is an explicit
//                         policy, not an ownership bypass.

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export function getActor(req) {
    const auth = req.auth ?? req.user;

    if (
        !auth ||
        typeof auth.userId !== "string" ||
        !OBJECT_ID.test(auth.userId) ||
        !Object.values(ROLES).includes(auth.role)
    ) {
        throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    }

    return {
        userId: auth.userId.toLowerCase(),
        role: auth.role,
        advisorId: auth.advisorId ? String(auth.advisorId).toLowerCase() : null
    };
}

export function forbidden(message = "You do not have permission to perform this action.", code = "FORBIDDEN") {
    return new AppError(message, 403, code);
}

export function requireRole(actor, roles, message) {
    if (!roles.includes(actor.role)) throw forbidden(message);
}

// What the caller may see. Always evaluated from the database on each
// request, so revoking a relationship or an assignment removes access
// immediately.
//   ALL       { kind: "ALL" }
//   OWNER     { kind: "OWNER", ownerId }
//   CAMPAIGNS { kind: "CAMPAIGNS", campaignIds }
export async function resolveScope(actor, { identity, campaigns }) {
    if (actor.role === ROLES.ADMIN) return { kind: "ALL" };

    if (actor.role === ROLES.ADVISOR) {
        return { kind: "OWNER", ownerId: actor.userId };
    }

    // Marketing Specialist: accepted relationship AND campaign assignment.
    const advisorIds = await identity.listAcceptedAdvisorIds(actor.userId);
    const campaignIds = await campaigns.listSpecialistCampaignIds(actor.userId, advisorIds);

    return { kind: "CAMPAIGNS", campaignIds };
}

export function canViewRule(scope, rule) {
    if (scope.kind === "ALL") return true;
    if (scope.kind === "OWNER") return String(rule.ownerId) === scope.ownerId;

    return Boolean(rule.campaignId) && scope.campaignIds.includes(String(rule.campaignId));
}

// Narrow a user-supplied ownerId filter. An advisor can only ask about
// themselves; asking about someone else is an authorization failure rather
// than a silently empty list.
export function assertOwnerFilterAllowed(scope, filters) {
    if (scope.kind === "OWNER" && filters.ownerId && filters.ownerId !== scope.ownerId) {
        throw forbidden("You can only view your own automation data.");
    }
}
