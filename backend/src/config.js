const config = Object.freeze({
    PORT: Number(process.env.PORT ?? 3001),

    NODE_ENV: process.env.NODE_ENV ?? "development",

    CORS_ORIGIN:
        process.env.CORS_ORIGIN ?? "http://localhost:8080",

    MONGO_URI: process.env.MONGO_URI ?? null,

    JWT_SECRET: process.env.JWT_SECRET ?? null,

    JWT_EXPIRES_IN:
        process.env.JWT_EXPIRES_IN ?? "1h",

    JWT_ISSUER:
        process.env.JWT_ISSUER ?? "finmarket-enterprise",

    JWT_AUDIENCE:
        process.env.JWT_AUDIENCE ?? "finmarket-api",

    GMAIL_USER: process.env.GMAIL_USER ?? null,

    GMAIL_APP_PASSWORD:
        process.env.GMAIL_APP_PASSWORD ?? null,

    META_ACCESS_TOKEN:
        process.env.META_ACCESS_TOKEN ?? null,

    META_PAGE_ID: process.env.META_PAGE_ID ?? null
});

export function validateConfiguration() {
    if (
        !Number.isInteger(config.PORT) ||
        config.PORT < 1 ||
        config.PORT > 65535
    ) {
        throw new Error("Invalid PORT configuration.");
    }

    if (!config.MONGO_URI) {
        throw new Error("MONGO_URI is required.");
    }

    if (
        !config.JWT_SECRET ||
        Buffer.byteLength(config.JWT_SECRET) < 32 ||
        config.JWT_SECRET.startsWith("REPLACE_") ||
        config.JWT_SECRET.startsWith("replace_")
    ) {
        throw new Error(
            "JWT_SECRET must contain at least 32 bytes of secret data."
        );
    }
}

export default config;