import mongoose from "mongoose";
import AppError from "../utils/AppError.js";
import logError from "../utils/logError.js";

export default function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    let statusCode = Number.isInteger(err.statusCode)
        ? err.statusCode
        : 500;

    let code = err.code ?? "INTERNAL_ERROR";
    let message = err.message ?? "Internal server error.";

    if (err.type === "entity.parse.failed") {
        statusCode = 400;
        code = "INVALID_JSON";
        message = "The request contains invalid JSON.";
    }

    if (err.type === "entity.too.large") {
        statusCode = 413;
        code = "PAYLOAD_TOO_LARGE";
        message = "The request body is too large.";
    }

    if (
        err instanceof mongoose.Error.ValidationError ||
        err instanceof mongoose.Error.CastError
    ) {
        statusCode = 400;
        code = "INVALID_REQUEST";
        message = "Invalid request data.";
    }

    if (err.code === 11000) {
        statusCode = 409;
        code = "DUPLICATE_RECORD";
        message = "A conflicting record already exists.";
    }

    if (
        [
            "MongoServerSelectionError",
            "MongooseServerSelectionError",
            "MongoNetworkError",
            "MongoNetworkTimeoutError",
            "MongoNotConnectedError",
            "MongoTopologyClosedError"
        ].includes(err.name)
    ) {
        statusCode = 503;
        code = "DATABASE_UNAVAILABLE";
        message = "Database temporarily unavailable.";
    }

    if (
        statusCode < 400 ||
        statusCode > 599
    ) {
        statusCode = 500;
    }

    if (statusCode >= 500) {
        logError("Server error:", err);

        if (statusCode === 503) {
            const safeErrors = {
                DATABASE_UNAVAILABLE:
                    "Database temporarily unavailable.",
                AUTH_UNAVAILABLE:
                    "Authentication is not available.",
                DELIVERY_UNAVAILABLE:
                    "Delivery service temporarily unavailable.",
                SERVICE_UNAVAILABLE:
                    "Service temporarily unavailable."
            };

            if (!Object.hasOwn(safeErrors, code)) {
                code = "SERVICE_UNAVAILABLE";
            }

            message = safeErrors[code];
        } else {
            code = "INTERNAL_ERROR";
            message = "Internal server error.";
        }
    }

    return res.status(statusCode).json({
        success: false,
        error: {
            code,
            message,
            details: []
        }
    });
}