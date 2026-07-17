import type { Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../middleware/errors.js";
import { readSettings, writeSettings, type SettingsMap } from "../lib/settings.js";

/**
 * GET /api/settings — public store settings as a { key: value } map. Read by the
 * storefront to decide which homepage sections to show, which payment methods
 * are enabled, etc. Never errors — returns {} so the storefront uses defaults.
 */
export async function getSettings(_req: Request, res: Response) {
  const map = await readSettings();
  res.json({ ok: true, data: map });
}

// Accept string / boolean / number values; everything is stored as text.
const updateSchema = z.record(z.string(), z.union([z.string(), z.boolean(), z.number()]));

/** PUT /api/admin/settings — merge one or more settings and save. */
export async function updateSettings(req: Request, res: Response) {
  const body = updateSchema.parse(req.body ?? {});
  const patch: SettingsMap = {};
  for (const [key, value] of Object.entries(body)) {
    patch[key] = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  }
  if (Object.keys(patch).length === 0) return res.json({ ok: true, message: "Nothing to update." });

  try {
    await writeSettings(patch);
  } catch (err) {
    throw new ApiError(500, `Could not save settings: ${err instanceof Error ? err.message : "storage error"}`);
  }
  res.json({ ok: true, message: "Settings saved." });
}
