const SAFE_ERROR_NAMES = new Set([
    "Error",
    "TypeError",
    "ReferenceError",
    "ValidationError",
    "CastError",
    "MongoServerError",
    "MongoNetworkError",
    "MongoServerSelectionError",
    "MongooseServerSelectionError",
    "AppError"
]);

export default function logError(context, error) {
    const name = SAFE_ERROR_NAMES.has(error?.name)
        ? error.name
        : "Error";

    const code = typeof error?.code === "number" ||
        (
            typeof error?.code === "string" &&
            /^[A-Z0-9_]{1,50}$/.test(error.code)
        )
        ? error.code
        : undefined;

    console.error(context, {
        name,
        ...(code !== undefined ? { code } : {}),
        ...(
            process.env.NODE_ENV === "development"
                ? {
                    message: String(
                        error?.message ?? ""
                    ).replace(
                        /mongodb(?:\+srv)?:\/\/[^\s]+/gi,
                        "[REDACTED_DATABASE_URI]"
                    )
                }
                : {}
        )
    });
}