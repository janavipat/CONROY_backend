import { supabaseAdmin } from "../../lib/supabase.js";
import type { NormalizedShipmentEvent } from "../../lib/shipping/provider.js";
import { eventForFulfillmentStatus, notifyOrderEvent } from "../../lib/orderNotifications.js";

/**
 * Mirrors status-map.ts's ranks, but keyed by the fulfillment_status STRING
 * (what's actually stored on `orders`) rather than the courier's own status —
 * this is what lets us compare "the order's current rank" against "the new
 * event's rank" without re-deriving anything from Delhivery's vocabulary.
 */
const FULFILLMENT_RANK: Record<string, number> = {
  Pending: 0,
  Confirmed: 0,
  Processing: 0,
  Packed: 0,
  Manifested: 1,
  Shipped: 2,
  "Out For Delivery": 3,
  "Attempt Failed": 3,
  Returning: 3,
  Delivered: 4,
  Returned: 4,
  Cancelled: 4,
};

export interface ApplyScanResult {
  /** True if this event moved orders.fulfillment_status forward. */
  applied: boolean;
  /** True if this exact (waybill, status, occurred_at) was already recorded. */
  deduped: boolean;
  /** True if no shipment row matches this waybill yet. */
  unmatched: boolean;
}

/**
 * Records one courier scan and, if it's a real forward step, advances the
 * order's fulfillment_status. Called from both the webhook and the
 * reconciliation poll (once built) — this is the only place that writes to
 * shipment_events or moves fulfillment_status from a courier event, so the
 * monotonic guarantee holds regardless of which path an event arrived by.
 */
export async function applyScan(event: NormalizedShipmentEvent): Promise<ApplyScanResult> {
  const { data: shipment } = await supabaseAdmin
    .from("shipments")
    .select("id, order_id")
    .eq("waybill", event.waybill)
    .maybeSingle();

  // Persist the raw scan first — evidence for disputes/support regardless of
  // whether we can act on it. Dedup constraint: unique(waybill, status, occurred_at).
  const { error: insErr } = await supabaseAdmin.from("shipment_events").insert({
    shipment_id: shipment?.id ?? null,
    waybill: event.waybill,
    status: event.status,
    status_type: event.statusType ?? null,
    location: event.location ?? null,
    remark: event.remark ?? null,
    occurred_at: event.occurredAt,
    payload: event.payload,
  });
  if (insErr) {
    if (insErr.code === "23505") return { applied: false, deduped: true, unmatched: false };
    throw new Error(insErr.message);
  }

  if (!shipment) return { applied: false, deduped: false, unmatched: true };

  await supabaseAdmin
    .from("shipments")
    .update({ status: event.status, updated_at: new Date().toISOString() })
    .eq("id", shipment.id);

  // rank 0 = an event status-map.ts didn't recognize — record it, but don't
  // let an unknown event touch the order's fulfillment_status.
  if (event.rank <= 0) return { applied: false, deduped: false, unmatched: false };

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("fulfillment_status")
    .eq("id", shipment.order_id)
    .maybeSingle();
  const currentRank = FULFILLMENT_RANK[(order?.fulfillment_status as string) ?? ""] ?? 0;

  // The monotonic guarantee: events arrive out of order (e.g. an In Transit
  // scan landing after Delivered) — never let a lower-rank event undo a
  // higher-rank one that already landed.
  if (event.rank < currentRank) return { applied: false, deduped: false, unmatched: false };

  await supabaseAdmin.from("orders").update({ fulfillment_status: event.internalStatus }).eq("id", shipment.order_id);

  // Tell the customer, but only about states they care about — Shipped, Out For
  // Delivery, Delivered. Reached only on a real forward move (every early
  // return above skips it), so a replayed or out-of-order scan can't message
  // twice; notifyOrderEvent's once-per-order guard is the second line.
  const customerEvent = eventForFulfillmentStatus(event.internalStatus);
  if (customerEvent) {
    void notifyOrderEvent(customerEvent, shipment.order_id as string, { waybill: event.waybill });
  }

  return { applied: true, deduped: false, unmatched: false };
}
