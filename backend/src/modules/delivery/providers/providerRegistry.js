import { sendMockDelivery } from "./mockProvider.js";
import { sendGmailDelivery } from "./gmailProvider.js";
import { sendFacebookDelivery } from "./facebookProvider.js";

export const resolveProviderName = (channel, env = process.env) => {
    if (channel === "EMAIL") {
        const mode = String(env.DELIVERY_EMAIL_PROVIDER ?? "mock")
            .trim()
            .toLowerCase();
        return mode === "gmail" ? "GMAIL_SMTP" : "MOCK_EMAIL";
    }

    if (channel === "FACEBOOK") {
        const mode = String(env.DELIVERY_FACEBOOK_PROVIDER ?? "mock")
            .trim()
            .toLowerCase();
        return mode === "meta" ? "META_FACEBOOK" : "MOCK_FACEBOOK";
    }

    return null;
};

export const dispatchToProvider = async (job, options = {}) => {
    const providerName =
        options.providerOverride ?? resolveProviderName(job.channel, options.env);

    if (providerName === "GMAIL_SMTP") {
        return sendGmailDelivery(job, options);
    }

    if (providerName === "META_FACEBOOK") {
        return sendFacebookDelivery(job, options);
    }

    return sendMockDelivery(job);
};