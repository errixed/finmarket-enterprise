const DEFAULT_GRAPH_VERSION = "v21.0";

const sanitizeErrorMessage = (message, secretValues = []) => {
    let safe = String(message || "Facebook Page publishing failed.");

    for (const secret of secretValues) {
        if (secret) {
            safe = safe.split(secret).join("[REDACTED]");
        }
    }

    return safe.slice(0, 500);
};

export const sendFacebookDelivery = async (job, options = {}) => {
    if (job.channel !== "FACEBOOK") {
        return {
            success: false,
            provider: "META_FACEBOOK",
            simulated: false,
            providerMessageId: null,
            errorMessage: "Facebook provider only supports FACEBOOK deliveries."
        };
    }

    const message = String(job.content?.body ?? "").trim();
    if (!message) {
        return {
            success: false,
            provider: "META_FACEBOOK",
            simulated: false,
            providerMessageId: null,
            errorMessage: "Post content body is required for Facebook publishing."
        };
    }

    const pageId = options.pageId ?? process.env.META_PAGE_ID;
    const accessToken = options.accessToken ?? process.env.META_ACCESS_TOKEN;
    const graphVersion =
        options.graphVersion ??
        process.env.META_GRAPH_API_VERSION ??
        DEFAULT_GRAPH_VERSION;

    if (!pageId || !accessToken) {
        return {
            success: false,
            provider: "META_FACEBOOK",
            simulated: false,
            providerMessageId: null,
            errorMessage: "Facebook Page publishing credentials are not configured."
        };
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/feed`;

    try {
        const response = await fetchImpl(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                message,
                access_token: accessToken
            })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data?.id) {
            const rawError =
                data?.error?.message ||
                `Meta Graph API responded with status ${response.status}.`;

            return {
                success: false,
                provider: "META_FACEBOOK",
                simulated: false,
                providerMessageId: null,
                errorMessage: sanitizeErrorMessage(rawError, [accessToken])
            };
        }

        return {
            success: true,
            provider: "META_FACEBOOK",
            simulated: false,
            providerMessageId: String(data.id),
            errorMessage: null
        };
    } catch (error) {
        return {
            success: false,
            provider: "META_FACEBOOK",
            simulated: false,
            providerMessageId: null,
            errorMessage: sanitizeErrorMessage(error?.message, [accessToken])
        };
    }
};