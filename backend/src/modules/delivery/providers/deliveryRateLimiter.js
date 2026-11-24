import AppError from "../../../utils/AppError.js";

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const createDeliveryRateLimiter = (initialConfig = {}) => {
    let config = {
        maxRequests: parsePositiveInt(
            initialConfig.maxRequests ?? process.env.DELIVERY_RATE_LIMIT_MAX,
            10
        ),
        windowMs: parsePositiveInt(
            initialConfig.windowMs ?? process.env.DELIVERY_RATE_LIMIT_WINDOW_MS,
            60_000
        ),
        maxConcurrent: parsePositiveInt(
            initialConfig.maxConcurrent ?? process.env.DELIVERY_MAX_CONCURRENT_SENDS,
            3
        )
    };

    const buckets = new Map();
    let activeSends = 0;

    const pruneBucket = (key, now) => {
        const cutoff = now - config.windowMs;
        const timestamps = (buckets.get(key) ?? []).filter((ts) => ts > cutoff);
        buckets.set(key, timestamps);
        return timestamps;
    };

    const acquire = (key = "GLOBAL") => {
        const now = Date.now();
        const timestamps = pruneBucket(key, now);

        if (activeSends >= config.maxConcurrent) {
            throw new AppError(
                "Too many concurrent delivery operations in progress.",
                429,
                "DELIVERY_CONCURRENCY_LIMITED"
            );
        }

        if (timestamps.length >= config.maxRequests) {
            throw new AppError(
                "Delivery provider rate limit exceeded. Please try again later.",
                429,
                "DELIVERY_RATE_LIMITED"
            );
        }

        activeSends += 1;
        timestamps.push(now);

        let released = false;
        return () => {
            if (!released) {
                released = true;
                activeSends = Math.max(0, activeSends - 1);
            }
        };
    };

    return {
        acquire,

        async run(key, operation) {
            const release = acquire(key);
            try {
                return await operation();
            } finally {
                release();
            }
        },

        configure(overrides = {}) {
            config = {
                maxRequests: parsePositiveInt(
                    overrides.maxRequests,
                    config.maxRequests
                ),
                windowMs: parsePositiveInt(overrides.windowMs, config.windowMs),
                maxConcurrent: parsePositiveInt(
                    overrides.maxConcurrent,
                    config.maxConcurrent
                )
            };
        },

        reset() {
            buckets.clear();
            activeSends = 0;
        },

        getState(key = "GLOBAL") {
            const timestamps = pruneBucket(key, Date.now());
            return {
                activeSends,
                recentCount: timestamps.length,
                ...config
            };
        }
    };
};

export const deliveryRateLimiter = createDeliveryRateLimiter();