import mongoose from "mongoose";

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
        err.name === "MongoServerSelectionError" ||
        err.name === "MongoNetworkError"
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
        console.error("Server error:", {
            name: err.name,
            code: err.code,
            message: err.message
        });

        if (statusCode === 500) {
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