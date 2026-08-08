import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";
import { runDueShipmentJobs } from "../services/shipping/jobs.js";

/**
 * POST /api/jobs/shipment/run — the daily cron's entrypoint (Vercel Hobby
 * plan caps cron at once/day; see jobs.ts for why that's a safety net here,
 * not the primary path). Also safe to hit manually while testing — it only
 * processes jobs that are actually due, so an extra call is a no-op.
 */
export async function runShipmentJobs(req: Request, res: Response) {
  const auth = req.headers.authorization;
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    throw new ApiError(401, "Unauthorized.");
  }
  const result = await runDueShipmentJobs();
  res.json({ ok: true, ...result });
}
