import User from "../modules/identity/models/User.js";
import AdvisorProfile from "../modules/identity/models/AdvisorProfile.js";
import AdvisorSpecialistAssignment from "../modules/identity/models/AdvisorSpecialistAssignment.js";

export default async function initializeIdentityModels() {
    await User.init();
    await AdvisorProfile.init();
    await AdvisorSpecialistAssignment.init();

    console.log("Identity indexes initialized.");
}