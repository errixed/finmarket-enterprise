export function createCampaignController(service) {
  const send = (res, data, status = 200) =>
    res.status(status).json({ success: true, data });
  return {
    createCampaign: async (req, res) =>
      send(res, await service.createCampaign(req.user, req.body), 201),
    listCampaigns: async (req, res) =>
      send(res, await service.listCampaigns(req.user, req.query)),
    getCampaign: async (req, res) =>
      send(res, await service.getCampaign(req.user, req.params.campaignId)),
    updateCampaign: async (req, res) =>
      send(
        res,
        await service.updateCampaign(req.user, req.params.campaignId, req.body),
      ),
    getAudience: async (req, res) =>
      send(res, await service.getAudience(req.user, req.params.campaignId)),
    createTemplate: async (req, res) =>
      send(res, await service.createTemplate(req.user, req.body), 201),
    listTemplates: async (req, res) =>
      send(res, await service.listTemplates(req.user, req.query)),
    getTemplate: async (req, res) =>
      send(res, await service.getTemplate(req.user, req.params.templateId)),
    assign: async (req, res) =>
      send(
        res,
        await service.assign(req.user, req.params.campaignId, req.body),
        201,
      ),
    specialists: async (req, res) =>
      send(res, await service.specialists(req.user, req.params.campaignId)),
    remove: async (req, res) =>
      send(
        res,
        await service.remove(
          req.user,
          req.params.campaignId,
          req.params.userId,
        ),
      ),
  };
}
export default createCampaignController;
