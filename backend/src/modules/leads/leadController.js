import * as service from "./leadService.js";

export async function create(req, res) {
    const data = await service.createLead(req.body, req.auth);
    return res.status(201).json({ success: true, data });
}
export async function list(req, res) {
    return res.json({ success: true, ...(await service.listLeads(req.query, req.auth)) });
}
export async function get(req, res) {
    const data = await service.getLead(req.params.id, req.auth);
    return res.json({ success: true, data });
}
export async function update(req, res) {
    const data = await service.updateLead(req.params.id, req.body, req.auth);
    return res.json({ success: true, data });
}
