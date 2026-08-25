import { supabaseAdmin } from "../../lib/supabase.js";
import { ApiError } from "../../middleware/errors.js";
import { delhiveryProvider } from "../../lib/shipping/providers/delhivery/index.js";
import type { ShipAddress } from "../../lib/shipping/provider.js";

/**
 * Denim is predictable — used only when a product's weight_g hasn't been set
 * yet (spec's own suggestion: "ship a constant if you must, ~600-700g/pair").
 */
const FALLBACK_ITEM_WEIGHT_G = 650;

const REQUIRED_ADDRESS_FIELDS = ["ship_name", "ship_phone", "ship_line1", "ship_city", "ship_state", "ship_pincode"] as const;

export interface CreateShipmentOutcome {
  ok: boolean;
  message: string;
  alreadyShipped?: boolean;
  waybill?: string;
  /** Set only when !ok — tells the job worker whether to retry or go dead. */
  classification?: "transient" | "permanent";
}

async function markFailed(shipmentId: string, message: string): Promise<void> {
  await supabaseAdmin
    .from("shipments")
    .update({ status: "failed", create_response: { error: message }, updated_at: new Date().toISOString() })
    .eq("id", shipmentId);
}

/**
 * The ONLY function allowed to write to `shipments` (spec's own rule) — admin
 * manual trigger, future cron worker, and future bulk actions all call this,
 * never Delhivery directly. Idempotent: a shipment row is inserted (or
 * reused) BEFORE the Delhivery call, so a request that times out mid-flight
 * leaves something to reconcile against instead of risking a duplicate.
 *
 * No job queue yet — this runs synchronously when called, from a manual
 * admin action only (see suggested build order: "trigger manually from
 * admin only" comes before the cron worker).
 */
export async function createShipmentForOrder(orderId: string): Promise<CreateShipmentOutcome> {
  const { data: order, error: oErr } = await supabaseAdmin
    .from("orders")
    .select("*, items:order_items(*)")
    .eq("id", orderId)
    .maybeSingle();
  if (oErr) throw new ApiError(500, oErr.message);
  if (!order) throw new ApiError(404, "Order not found.");

  /*
   * A cancelled order must never be handed to the courier. The create job is
   * queued at checkout and survives independently of the order, so without
   * this an order cancelled while its job was still pending would be manifested
   * afterwards — the customer cancels, and a parcel goes out anyway.
   */
  if (order.status === "cancelled" || order.fulfillment_status === "Cancelled") {
    return {
      ok: false,
      classification: "permanent",
      message: "Order is cancelled — no shipment was created.",
    };
  }

  // Same reasoning for a deleted order: it has left the working lists, so
  // nothing should be handed to the courier on its behalf.
  if (order.deleted_at) {
    return {
      ok: false,
      classification: "permanent",
      message: "Order is deleted — no shipment was created.",
    };
  }

  const missing = REQUIRED_ADDRESS_FIELDS.filter((k) => !order[k]);
  if (missing.length) {
    return {
      ok: false,
      classification: "permanent",
      message: `Missing structured address field(s): ${missing.join(", ")}. This order predates the address migration or was placed before it — edit the order with the customer's full address first.`,
    };
  }

  // Idempotency layer 1 (DB): a shipment row already exists for this order.
  const { data: existing } = await supabaseAdmin.from("shipments").select("*").eq("order_id", orderId).maybeSingle();
  if (existing?.waybill) {
    return { ok: true, message: `Already shipped — waybill ${existing.waybill}.`, alreadyShipped: true, waybill: existing.waybill as string };
  }

  let shipmentId: string = existing?.id as string;
  if (!shipmentId) {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("shipments")
      .insert({ order_id: orderId, ref_no: orderId, status: "pending" })
      .select("id")
      .single();
    if (insErr) {
      // 23505 = another concurrent request beat us to the insert.
      if (insErr.code === "23505") {
        const { data: raced } = await supabaseAdmin.from("shipments").select("*").eq("order_id", orderId).maybeSingle();
        if (raced?.waybill) {
          return { ok: true, message: `Already shipped — waybill ${raced.waybill}.`, alreadyShipped: true, waybill: raced.waybill as string };
        }
        if (raced) shipmentId = raced.id as string;
      } else {
        throw new ApiError(500, insErr.message);
      }
    } else {
      shipmentId = inserted.id as string;
    }
  }

  const items = (order.items as { product_handle: string; title: string; quantity: number }[]) ?? [];
  if (!items.length) {
    await markFailed(shipmentId, "Order has no items.");
    return { ok: false, classification: "permanent", message: "Order has no items." };
  }

  const handles = [...new Set(items.map((i) => i.product_handle))];
  const { data: products } = await supabaseAdmin
    .from("products")
    .select("handle, weight_g, is_shippable")
    .in("handle", handles);
  const productByHandle = new Map((products ?? []).map((p) => [p.handle as string, p]));

  const unshippable = items.filter((i) => productByHandle.get(i.product_handle)?.is_shippable === false);
  if (unshippable.length) {
    const message = `Order contains non-shippable product(s): ${unshippable.map((i) => i.title).join(", ")}.`;
    await markFailed(shipmentId, message);
    return { ok: false, classification: "permanent", message };
  }

  let totalWeightG = 0;
  let anyWeightMissing = false;
  for (const item of items) {
    const w = productByHandle.get(item.product_handle)?.weight_g as number | null | undefined;
    if (!w) anyWeightMissing = true;
    totalWeightG += (w || FALLBACK_ITEM_WEIGHT_G) * item.quantity;
  }

  const declaredValue = ((order.subtotal as number) ?? 0) - ((order.discount as number) ?? 0);
  const isCod = order.status === "cod_pending";

  const shipTo: ShipAddress = {
    name: order.ship_name as string,
    phone: order.ship_phone as string,
    line1: order.ship_line1 as string,
    line2: (order.ship_line2 as string) || undefined,
    city: order.ship_city as string,
    state: order.ship_state as string,
    pincode: order.ship_pincode as string,
    country: (order.ship_country as string) || "India",
  };

  const result = await delhiveryProvider.createShipment({
    orderId,
    shipTo,
    paymentMode: isCod ? "cod" : "prepaid",
    codAmount: isCod ? declaredValue : undefined,
    items: items.map((i) => ({ title: i.title, quantity: i.quantity })),
    declaredValue,
    weightG: totalWeightG,
    // Per-item dimensions can't be summed into one package's L/W/H for a
    // multi-item order — omitted until packages are modeled properly
    // (spec section 40/41's multi-shipment/multi-package evolution).
  });

  if (!result.ok) {
    await supabaseAdmin
      .from("shipments")
      .update({ status: "failed", declared_g: totalWeightG, create_response: result.raw, updated_at: new Date().toISOString() })
      .eq("id", shipmentId);
    return {
      ok: false,
      classification: result.error?.classification ?? "transient",
      message: result.error?.message ?? "Delhivery rejected the shipment.",
    };
  }

  const { error: shipUpdateErr } = await supabaseAdmin
    .from("shipments")
    .update({
      waybill: result.waybill,
      status: result.status || "Manifested",
      declared_g: totalWeightG,
      create_response: result.raw,
      updated_at: new Date().toISOString(),
    })
    .eq("id", shipmentId);
  if (shipUpdateErr) {
    console.error(`Shipment ${shipmentId} created on Delhivery (waybill ${result.waybill}) but the DB update failed:`, shipUpdateErr.message);
  }

  // First transition after creation — always a forward move from
  // Pending/Confirmed, so no need for the monotonic-rank check that webhook
  // events (applyScan.ts, not yet built) will need.
  const { error: orderUpdateErr } = await supabaseAdmin
    .from("orders")
    .update({ fulfillment_status: "Manifested" })
    .eq("id", orderId);
  if (orderUpdateErr) {
    console.error(`Order ${orderId} shipped (waybill ${result.waybill}) but fulfillment_status update failed:`, orderUpdateErr.message);
  }

  return {
    ok: true,
    waybill: result.waybill,
    message: anyWeightMissing
      ? `Shipment created — waybill ${result.waybill}. Some items had no weight set; used a ${FALLBACK_ITEM_WEIGHT_G}g default per unit.`
      : `Shipment created — waybill ${result.waybill}.`,
  };
}
