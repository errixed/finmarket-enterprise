import User from "../modules/identity/models/User.js";
import AdvisorProfile from "../modules/identity/models/AdvisorProfile.js";
import AdvisorSpecialistAssignment from "../modules/identity/models/AdvisorSpecialistAssignment.js";

export default async function initializeIdentityModels() {
    await Promise.all([
        User.init(),
        AdvisorProfile.init(),
        AdvisorSpecialistAssignment.init()
    ]);

    console.log("Identity collections initialized.");
}