import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";
import { whatsappConfigured, sendWhatsappOtp } from "../lib/whatsapp.js";

/**
 * GET /api/admin/whatsapp/health — reports whether WhatsApp OTP is wired up.
 * Never returns the token itself, only whether it's present.
 */
export async function whatsappHealth(_req: Request, res: Response) {
  res.json({
    ok: true,
    data: {
      configured: whatsappConfigured,
      hasToken: Boolean(env.WHATSAPP_ACCESS_TOKEN),
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || null,
      templateName: env.WHATSAPP_TEMPLATE_NAME || null,
      templateLang: env.WHATSAPP_TEMPLATE_LANG,
      otpMock: env.otpMock,
      // Plain-English next step.
      hint: !env.WHATSAPP_ACCESS_TOKEN
        ? "WHATSAPP_ACCESS_TOKEN is empty — paste your token in .env and restart."
        : whatsappConfigured
          ? "WhatsApp is configured. Use POST /api/admin/whatsapp/test to send a live test."
          : "Missing phone number id or template name.",
    },
  });
}

const testSchema = z.object({ to: z.string().min(8).max(20) });

/**
 * POST /api/admin/whatsapp/test { to } — sends the OTP template to `to` and
 * returns Meta's RAW response (message id on success, or the exact error) so
 * delivery problems are visible instead of a silent "sent".
 */
export async function whatsappTest(req: Request, res: Response) {
  const { to } = testSchema.parse(req.body);
  if (!whatsappConfigured) {
    throw new ApiError(
      400,
      "WhatsApp not configured — set WHATSAPP_ACCESS_TOKEN (+ phone id + template) in .env and restart.",
    );
  }
  try {
    const messageId = await sendWhatsappOtp(to, "123456");
    res.json({ ok: true, message: `Accepted by Meta — check WhatsApp on ${to}.`, messageId });
  } catch (err) {
    // Surface Meta's own error text (e.g. number-not-registered, template mismatch).
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
