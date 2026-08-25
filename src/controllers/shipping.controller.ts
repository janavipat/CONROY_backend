import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { createShipmentForOrder } from "../services/shipping/createShipment.js";
import { delhiveryProvider } from "../lib/shipping/providers/delhivery/index.js";

/**
 * POST /api/admin/orders/:orderId/shipment — manually creates a Delhivery
 * shipment for one order. Admin-only for now (no cron/automation yet — see
 * services/shipping/createShipment.ts for why).
 */
export async function createShipmentAction(req: Request, res: Response) {
  const { orderId } = req.params;
  const result = await createShipmentForOrder(orderId);
  res.status(result.ok ? 200 : 422).json({ ok: result.ok, message: result.message, data: { waybill: result.waybill } });
}

/** GET /api/admin/orders/:orderId/shipment — current shipment state for one order. */
export async function getShipmentForOrder(req: Request, res: Response) {
  const { orderId } = req.params;
  const { data, error } = await supabaseAdmin.from("shipments").select("*").eq("order_id", orderId).maybeSingle();
  if (error) throw new ApiError(500, error.message);
  res.json({ ok: true, data: data ?? null });
}

/**
 * GET /api/admin/orders/:orderId/shipment/track — the courier's own view of a
 * shipment, read straight from Delhivery through the existing provider.
 *
 * Read-only. Our shipments table records what we last wrote; this answers the
 * different question of what Delhivery currently believes, which is what
 * matters when checking that a cancellation or deletion really landed.
 */
export async function trackShipmentForOrder(req: Request, res: Response) {
  const { orderId } = req.params;

  const { data, error } = await supabaseAdmin
    .from("shipments")
    .select("waybill, status")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);

  const waybill = (data?.waybill as string | undefined) ?? undefined;
  if (!waybill) throw new ApiError(404, "No shipment for this order.");

  const tracked = await delhiveryProvider.trackShipment({ waybill });
  res.json({
    ok: tracked.ok,
    data: {
      waybill,
      localStatus: data?.status ?? null,
      courierStatus: tracked.events.at(-1)?.status ?? null,
      events: tracked.events,
      error: tracked.error?.message ?? null,
    },
  });
}
