import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { normalizeStatus } from "../lib/shipping/providers/delhivery/status-map.js";
import { applyScan } from "../services/shipping/applyScan.js";

interface ScanLike {
  Status?: string;
  StatusType?: string;
  StatusDateTime?: string;
  StatusLocation?: string;
  Instructions?: string;
}

/**
 * Delhivery's exact webhook payload shape has NOT been verified — no
 * shipment has been created yet, so no real webhook has ever been received.
 * This defensively tries the shapes Delhivery is known to use elsewhere
 * (their tracking API's ShipmentData/Shipment/Status nesting, and flatter
 * variants some accounts get instead). The raw body is always logged and
 * persisted regardless of whether extraction succeeds, specifically so the
 * first real delivery can be inspected and this function corrected against
 * real data.
 */
function extractScan(body: unknown): { waybill: string; scan: ScanLike } | null {
  const b = body as Record<string, unknown>;

  // Shape A: same as the tracking API — { ShipmentData: [{ Shipment: {...} }] }
  const fromShipmentData = (b?.ShipmentData as { Shipment?: Record<string, unknown> }[] | undefined)?.[0]?.Shipment;
  // Shape B: { Shipment: { AWB, Status: {...} } }
  const fromShipment = b?.Shipment as Record<string, unknown> | undefined;
  const shipment = fromShipmentData ?? fromShipment;

  if (shipment) {
    const waybill = (shipment.AWB as string) ?? (shipment.waybill as string);
    const status = shipment.Status as ScanLike | string | undefined;
    if (waybill && status) {
      const scan = typeof status === "string" ? { Status: status } : status;
      return { waybill, scan };
    }
  }

  // Shape C: flat — { AWB or Waybill, Status, StatusType, StatusDateTime, ... }
  const waybill = (b?.AWB as string) ?? (b?.Waybill as string) ?? (b?.waybill as string);
  const status = b?.Status as string | undefined;
  if (waybill && status) {
    return {
      waybill,
      scan: {
        Status: status,
        StatusType: b?.StatusType as string | undefined,
        StatusDateTime: b?.StatusDateTime as string | undefined,
        StatusLocation: (b?.StatusLocation as string) ?? (b?.StatusLoc as string | undefined),
        Instructions: b?.Instructions as string | undefined,
      },
    };
  }

  return null;
}

/**
 * POST /api/webhooks/delhivery/:token — the path token IS the auth, since
 * this Delhivery account has no shared-secret webhook signature available
 * (confirmed 2026-08-09 — not in the dashboard). Responds fast; no real
 * work happens beyond persist + apply.
 */
export async function delhiveryWebhook(req: Request, res: Response) {
  const { token } = req.params;
  if (!env.DELHIVERY_WEBHOOK_TOKEN || token !== env.DELHIVERY_WEBHOOK_TOKEN) {
    // 404, not 401/403 — don't confirm to a prober that this path exists at all.
    res.status(404).end();
    return;
  }

  // Always log the raw body, win or lose on parsing — this is the only way
  // to correct extractScan() once real webhooks start arriving.
  console.log("Delhivery webhook received:", JSON.stringify(req.body));

  const extracted = extractScan(req.body);
  if (!extracted) {
    console.warn("Delhivery webhook: could not extract a waybill/status from the payload — see raw body above.");
    res.status(200).json({ ok: true, note: "unrecognized payload shape, logged for review" });
    return;
  }

  const event = normalizeStatus(extracted.waybill, extracted.scan);
  if (!event) {
    res.status(200).json({ ok: true, note: "no status in payload" });
    return;
  }
  // Store the full original webhook body, not just the reshaped subset used
  // for status extraction — that's the actual evidence for disputes/support.
  event.payload = req.body;

  try {
    const result = await applyScan(event);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    // Never fail the webhook response over a DB hiccup — Delhivery will
    // retry, and the reconciliation poll (once built) is the real backstop.
    console.error("Delhivery webhook: applyScan failed:", err instanceof Error ? err.message : err);
    res.status(200).json({ ok: true, note: "processing error, logged" });
  }
}
