import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { router } from "./routes/index.js";
import { errorHandler, notFound } from "./middleware/errors.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));

  // CORS — only the configured frontend origins may call the API.
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow same-origin / server-to-server calls (no Origin header).
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin not allowed by CORS: ${origin}`));
      },
      credentials: true,
    }),
  );

  app.use(morgan(env.isProd ? "combined" : "dev"));

  // Basic rate limiting to protect write endpoints.
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Health check
  app.get("/health", (_req, res) => res.json({ ok: true, service: "conroy-backend" }));

  app.use("/api", router);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
