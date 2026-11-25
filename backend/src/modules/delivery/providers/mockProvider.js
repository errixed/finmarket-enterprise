import { Types } from "mongoose";

export const sendMockDelivery = async (job) => {
    if (job.channel === "EMAIL") {
        return {
            success: true,
            provider: "MOCK_EMAIL",
            simulated: true,
            providerMessageId: `mock-email-${new Types.ObjectId()}`,
            errorMessage: null
        };
    }

    if (job.channel === "FACEBOOK") {
        return {
            success: true,
            provider: "MOCK_FACEBOOK",
            simulated: true,
            providerMessageId: `mock-facebook-${new Types.ObjectId()}`,
            errorMessage: null
        };
    }

    return {
        success: false,
        provider: null,
        simulated: true,
        providerMessageId: null,
        errorMessage: "Unsupported delivery channel."
    };
};