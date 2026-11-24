import * as deliveryService from "../services/deliveryService.js";

export const queueDelivery = async (req, res, next) => {
    try {
        const job = await deliveryService.queueDelivery(req.body, req.auth);
        res.status(201).json({
            success: true,
            data: job
        });
    } catch (error) {
        next(error);
    }
};

export const getDeliveryHistory = async (req, res, next) => {
    try {
        const result = await deliveryService.getDeliveryHistory(
            req.query,
            req.auth
        );
        res.status(200).json({
            success: true,
            data: result.items,
            pagination: result.pagination
        });
    } catch (error) {
        next(error);
    }
};

export const getDeliveryById = async (req, res, next) => {
    try {
        const job = await deliveryService.getDeliveryById(
            req.params.id,
            req.auth
        );
        res.status(200).json({
            success: true,
            data: job
        });
    } catch (error) {
        next(error);
    }
};

export const processDelivery = async (req, res, next) => {
    try {
        const job = await deliveryService.processDelivery(
            req.params.id,
            req.auth
        );
        res.status(200).json({
            success: true,
            data: job
        });
    } catch (error) {
        next(error);
    }
};

export const retryDelivery = async (req, res, next) => {
    try {
        const job = await deliveryService.retryDelivery(
            req.params.id,
            req.auth
        );
        res.status(200).json({
            success: true,
            data: job
        });
    } catch (error) {
        next(error);
    }
};