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

  // Trust the first proxy hop. Required whenever this runs behind a reverse
  // proxy (Vercel's edge network, Railway, nginx, …) — those always add an
  // X-Forwarded-For header, and without this express-rate-limit throws
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request (asynchronously,
  // which crashes the whole process on a platform like Vercel instead of
  // producing a normal HTTP error).
  app.set("trust proxy", 1);

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

  // Health check. Reports which environment this deployment believes it is and,
  // in staging, which database and price it is running with — enough to tell a
  // correctly wired staging API from a misconfigured one without reading logs.
  // The Supabase *ref* is public (it ships in the frontend bundle); no key is
  // exposed, and nothing extra is reported on a production deployment.
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      service: "conroy-backend",
      env: env.appEnv,
      ...(env.isStaging
        ? {
            staging: {
              supabaseRef: env.SUPABASE_URL.replace(/^https?:\/\//, "").split(".")[0],
              priceOverrideInr: env.stagingPriceOverride,
              razorpayMode: env.RAZORPAY_KEY_ID.startsWith("rzp_test_")
                ? "test"
                : env.RAZORPAY_KEY_ID
                  ? "unknown"
                  : "demo",
            },
          }
        : {}),
    }),
  );

  app.use("/api", router);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
