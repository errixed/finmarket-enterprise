import nodemailer from "nodemailer";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sanitizeErrorMessage = (error, secretValues = []) => {
    let message = error?.message || "Gmail SMTP delivery failed.";

    for (const secret of secretValues) {
        if (secret) {
            message = message.split(secret).join("[REDACTED]");
        }
    }

    return message.slice(0, 500);
};

export const sendGmailDelivery = async (job, options = {}) => {
    if (job.channel !== "EMAIL") {
        return {
            success: false,
            provider: "GMAIL_SMTP",
            simulated: false,
            providerMessageId: null,
            errorMessage: "Gmail provider only supports EMAIL deliveries."
        };
    }

    const recipientEmail = String(job.recipientEmail ?? "").trim().toLowerCase();
    if (!EMAIL_REGEX.test(recipientEmail)) {
        return {
            success: false,
            provider: "GMAIL_SMTP",
            simulated: false,
            providerMessageId: null,
            errorMessage: "A valid recipient email address is required."
        };
    }

    const body = String(job.content?.body ?? "").trim();
    if (!body) {
        return {
            success: false,
            provider: "GMAIL_SMTP",
            simulated: false,
            providerMessageId: null,
            errorMessage: "Email body content is required."
        };
    }

    const user = options.user ?? process.env.GMAIL_USER;
    const pass = options.pass ?? process.env.GMAIL_APP_PASSWORD;

    if (!options.transporter && (!user || !pass)) {
        return {
            success: false,
            provider: "GMAIL_SMTP",
            simulated: false,
            providerMessageId: null,
            errorMessage: "Gmail SMTP credentials are not configured."
        };
    }

    try {
        const transporter =
            options.transporter ??
            nodemailer.createTransport({
                service: "gmail",
                auth: { user, pass }
            });

        const info = await transporter.sendMail({
            from: user || "no-reply@finmarket.local",
            to: recipientEmail,
            subject: job.content?.subject?.trim() || "FinMarket Update",
            text: body
        });

        return {
            success: true,
            provider: "GMAIL_SMTP",
            simulated: false,
            providerMessageId: info?.messageId ? String(info.messageId) : null,
            errorMessage: null
        };
    } catch (error) {
        return {
            success: false,
            provider: "GMAIL_SMTP",
            simulated: false,
            providerMessageId: null,
            errorMessage: sanitizeErrorMessage(error, [pass])
        };
    }
};