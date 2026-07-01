import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { ApiError } from "./errors.js";

/**
 * Protects /api/admin/* routes with a shared admin key sent as `x-admin-key`.
 * If ADMIN_KEY is unset, access is open (dev convenience) — a startup warning
 * is logged so this isn't forgotten before deploying.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!env.ADMIN_KEY) return next(); // open in dev when no key configured
  const provided = req.header("x-admin-key");
  if (provided && provided === env.ADMIN_KEY) return next();
  throw new ApiError(401, "Admin authentication required.");
}
