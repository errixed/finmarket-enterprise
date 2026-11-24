import { getActor } from "./automationAccess.js";

// Controllers read the request and shape the response. They do not query
// MongoDB and contain no business rules; both live in the service layer.
// The acting user always comes from the shared authentication middleware
// (req.auth / req.user), never from the request body.

export function createAutomationController(service) {
    const handle = (work) => async (req, res, next) => {
        try {
            await work(getActor(req), req, res);
        } catch (error) {
            next(error);
        }
    };

    const sendPage = (res, { items, pagination }) =>
        res.status(200).json({
            success: true,
            count: items.length,
            pagination,
            data: items
        });

    return {
        createAutomation: handle(async (actor, req, res) => {
            const rule = await service.createRule(actor, req.body);

            res.status(201).json({ success: true, data: rule });
        }),

        listAutomations: handle(async (actor, req, res) => {
            sendPage(res, await service.listRules(actor, req.query));
        }),

        getAutomation: handle(async (actor, req, res) => {
            const rule = await service.getRule(actor, req.params.id);

            res.status(200).json({ success: true, data: rule });
        }),

        updateAutomation: handle(async (actor, req, res) => {
            const rule = await service.updateRule(actor, req.params.id, req.body);

            res.status(200).json({ success: true, data: rule });
        }),

        simulateEvent: handle(async (actor, req, res) => {
            const result = await service.simulateEvent(actor, req.body);

            res.status(201).json({ success: true, data: result });
        }),

        listEvents: handle(async (actor, req, res) => {
            sendPage(res, await service.listEvents(actor, req.query));
        }),

        listExecutions: handle(async (actor, req, res) => {
            sendPage(res, await service.listExecutions(actor, req.query));
        }),

        getAnalyticsSummary: handle(async (actor, req, res) => {
            const summary = await service.getAnalyticsSummary(actor);

            res.status(200).json({ success: true, data: summary });
        })
    };
}

export default createAutomationController;
