import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { whatsappConfigured, sendWhatsappOtp } from "../lib/whatsapp.js";
import {
  ORDER_EVENTS,
  notificationsEnabled,
  notifyLang,
  sendSampleNotification,
  templateSpec,
  type OrderEvent,
} from "../lib/orderNotifications.js";

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
      // Order-lifecycle notifications (separate from OTP: same number, own
      // templates, own on/off switch).
      notifications: {
        enabled: notificationsEnabled,
        lang: notifyLang(),
        events: ORDER_EVENTS.map((e) => ({ event: e, ...templateSpec(e) })),
      },
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

const GRAPH_VERSION = "v21.0";

/** One template as Meta reports it. */
interface MetaTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  components?: Array<{ type: string; text?: string }>;
}

/** How many {{n}} placeholders a template's BODY declares. */
function bodyVariableCount(tpl: MetaTemplate): number {
  const body = tpl.components?.find((c) => c.type?.toUpperCase() === "BODY");
  const matches = body?.text?.match(/\{\{\s*\d+\s*\}\}/g) ?? [];
  // Distinct indices — a template may repeat {{1}} and that is still one variable.
  return new Set(matches.map((m) => m.replace(/\D/g, ""))).size;
}

/**
 * GET /api/admin/whatsapp/templates — reads the live templates back from Meta
 * and checks each lifecycle event against the one it is configured to use.
 *
 * This exists because a template mismatch is otherwise invisible until a real
 * customer misses a real message: Meta rejects a send outright (error 132000)
 * when the number of variables we pass differs from the approved body, and
 * renaming a template in WhatsApp Manager silently breaks the name we send.
 * Checking here turns both into something the admin panel can show.
 */
export async function whatsappTemplates(_req: Request, res: Response) {
  if (!env.WHATSAPP_BUSINESS_ACCOUNT_ID) {
    throw new ApiError(
      400,
      "Set WHATSAPP_BUSINESS_ACCOUNT_ID in .env to read templates. " +
        "Find it in WhatsApp Manager → Account tools → WhatsApp Business Account ID.",
    );
  }

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}` +
    `/message_templates?limit=200&fields=name,language,status,category,components`;

  const meta = await fetch(url, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((err: Error) => {
    throw new ApiError(503, `Couldn't reach WhatsApp (${err.message}).`);
  });

  const payload = (await meta.json().catch(() => ({}))) as {
    data?: MetaTemplate[];
    error?: { message?: string };
  };
  if (!meta.ok) {
    throw new ApiError(502, payload.error?.message ?? `Meta returned HTTP ${meta.status}.`);
  }

  const live = payload.data ?? [];
  const lang = notifyLang();

  // One row per lifecycle event: what we're configured to send vs. what Meta
  // actually has approved under that name.
  const checks = ORDER_EVENTS.map((event: OrderEvent) => {
    const spec = templateSpec(event);
    const byName = live.filter((t) => t.name === spec.name);
    const exact = byName.find((t) => t.language === lang);
    const match = exact ?? byName[0];

    const problems: string[] = [];
    if (byName.length === 0) {
      problems.push(`No template named "${spec.name}" exists on this WhatsApp account.`);
    } else if (!exact) {
      const langs = byName.map((t) => t.language).join(", ");
      problems.push(`Exists, but not in language "${lang}" — found: ${langs}.`);
    }
    if (match) {
      if (match.status !== "APPROVED") {
        problems.push(`Template status is ${match.status}, not APPROVED.`);
      }
      const declared = bodyVariableCount(match);
      if (declared !== spec.variableCount) {
        problems.push(
          `Variable count mismatch: the template body uses ${declared}, ` +
            `the server sends ${spec.variableCount}. Meta will reject the send.`,
        );
      }
    }

    return {
      event,
      template: spec.name,
      sendsVariables: spec.variableCount,
      metaStatus: match?.status ?? null,
      metaCategory: match?.category ?? null,
      metaLanguage: match?.language ?? null,
      metaVariables: match ? bodyVariableCount(match) : null,
      metaBody: match?.components?.find((c) => c.type?.toUpperCase() === "BODY")?.text ?? null,
      ok: problems.length === 0,
      problems,
    };
  });

  res.json({
    ok: checks.every((c) => c.ok),
    data: {
      lang,
      notificationsEnabled,
      checks,
      // Everything on the account, so an admin can spot a name they meant to use.
      allTemplates: live.map((t) => ({
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category,
        variables: bodyVariableCount(t),
      })),
    },
  });
}

const notifyTestSchema = z.object({
  to: z.string().min(8).max(20),
  event: z.enum(ORDER_EVENTS as [OrderEvent, ...OrderEvent[]]),
});

/**
 * POST /api/admin/whatsapp/notify-test { to, event } — sends one lifecycle
 * template filled with sample values. Bypasses the once-per-order guard (there
 * is no order involved) so it can be re-run while getting a template right.
 */
export async function whatsappNotifyTest(req: Request, res: Response) {
  const { to, event } = notifyTestSchema.parse(req.body);
  if (!notificationsEnabled) {
    throw new ApiError(
      400,
      "Order notifications are off — set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID " +
        "and WHATSAPP_NOTIFY_ENABLED=true, then restart.",
    );
  }
  try {
    const messageId = await sendSampleNotification(event, to);
    res.json({
      ok: true,
      message: `Sent "${event}" to ${to} — check WhatsApp.`,
      template: templateSpec(event).name,
      messageId,
    });
  } catch (err) {
    res.json({
      ok: false,
      template: templateSpec(event).name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * GET /api/admin/orders/:id/notifications — every WhatsApp message sent (or
 * skipped, or failed) for one order, newest first. This is what lets support
 * answer "did the customer get told?" without digging through server logs.
 */
export async function orderWhatsappLog(req: Request, res: Response) {
  const { id } = req.params;
  const { data, error } = await supabaseAdmin
    .from("whatsapp_notifications")
    .select("*")
    .eq("order_id", id)
    .order("created_at", { ascending: false });

  // A database that hasn't run whatsapp-notifications.sql yet should read as
  // "no messages logged", not as a broken admin page.
  if (error) {
    console.warn("Notification log unavailable:", error.message);
    return res.json({ ok: true, count: 0, data: [], unavailable: true });
  }

  res.json({ ok: true, count: data?.length ?? 0, data: data ?? [] });
}
