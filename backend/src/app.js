import express from "express";
import cors from "cors";
import helmet from "helmet";

import config from "./config.js";
import apiRoutes from "./routes/index.js";

import errorHandler from "./middleware/errorHandler.js";
import notFoundMiddleware from "./middleware/notFoundMiddleware.js";
import requestLogger from "./middleware/requestLogger.js";

const app = express();

app.disable("x-powered-by");

app.use(helmet());

app.use(cors({
    origin: config.CORS_ORIGIN
}));

app.use(express.json({
    limit: "100kb"
}));

app.use(requestLogger);

app.use("/api/v1", apiRoutes);

app.use(notFoundMiddleware);
app.use(errorHandler);

export default app;