import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { createShipmentForOrder } from "../services/shipping/createShipment.js";

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
