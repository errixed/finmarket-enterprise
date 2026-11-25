export default function requestLogger(req, res, next) {
    const start = performance.now();

    res.on("finish", () => {
        const duration = (
            performance.now() - start
        ).toFixed(2);

        const timestamp = new Date().toISOString();

        const path = req.originalUrl
            .split("?")[0]
            .replace(/[\r\n]/g, "");

        console.log(
            `[${timestamp}] ${req.method} ${path} ${res.statusCode} - ${duration}ms`
        );
    });

    next();
}