import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { cancelOrderSchema, CANCELLABLE_STATUSES } from "../validators/schemas.js";
import { createOrderSchema } from "../validators/schemas.js";
import { resolveCart, persistOrder } from "../lib/pricing.js";
import { computeDiscount } from "../lib/offers.js";
import { delhiveryProvider } from "../lib/shipping/providers/delhivery/index.js";

/**
 * POST /api/orders — creates an order; prices are resolved server-side.
 * Online payments now flow through /api/payments/razorpay (create → verify),
 * so this endpoint is primarily for Cash on Delivery. An "online" order that
 * reaches here (e.g. demo mode with no Razorpay keys) is recorded as paid.
 */
export async function createOrder(req: Request, res: Response) {
  const input = createOrderSchema.parse(req.body);

  const cart = await resolveCart(input.items);
  // Re-apply the active offer server-side (never trust a client-sent discount).
  const offer = await computeDiscount(cart.lineItems, cart.subtotal, input.code);

  const order = await persistOrder({
    email: input.email,
    fullName: input.fullName,
    phone: input.phone,
    shippingAddress: input.shippingAddress,
    shipAddress: input.shipAddress,
    // COD orders await collection on delivery; online orders are paid.
    status: input.paymentMethod === "cod" ? "cod_pending" : "paid",
    cart,
    discount: offer.discount,
    offerCode: offer.code,
  });

  res.status(201).json({
    ok: true,
    message: "Order placed successfully.",
    data: order,
  });
}

/** GET /api/orders?phone=+91… — a signed-in user's order history. */
export async function listOrdersByPhone(req: Request, res: Response) {
  const phone = String(req.query.phone ?? "").trim();
  if (!phone) throw new ApiError(400, "A phone query parameter is required.");

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*, items:order_items(*)")
    .eq("phone", phone)
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);

  res.json({ ok: true, count: data?.length ?? 0, data: data ?? [] });
}

/**
 * PATCH /api/orders/:id/cancel — customer cancels an eligible order.
 *
 * Validates that the order exists, belongs to the requester, is still in a
 * cancellable state and isn't already cancelled. On success it records the
 * reason, restores the reserved stock and sets the refund state: COD orders
 * collected nothing so there is nothing to refund, online payments enter the
 * refund workflow.
 */
export async function cancelOrder(req: Request, res: Response) {
  const { id } = req.params;
  const input = cancelOrderSchema.parse(req.body);

  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("*, items:order_items(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!order) throw new ApiError(404, "Order not found.");

  // Ownership — same phone-based model as the order-history endpoint.
  if (order.phone !== input.phone) {
    throw new ApiError(403, "You can only cancel your own orders.");
  }

  const fulfillment = (order.fulfillment_status as string) ?? "Pending";
  if (fulfillment === "Cancelled" || order.status === "cancelled") {
    throw new ApiError(409, "This order is already cancelled.");
  }
  if (!CANCELLABLE_STATUSES.includes(fulfillment as (typeof CANCELLABLE_STATUSES)[number])) {
    throw new ApiError(409, "This order can no longer be cancelled.");
  }

  /*
   * A manifested order already has a waybill, so the courier is expecting to
   * collect it. Cancel that first: if the order were marked cancelled while
   * the shipment stayed live, Delhivery would still pick the parcel up and the
   * customer would receive an order they had cancelled.
   *
   * This runs before the order is touched, so a refusal leaves the order
   * exactly as it was and the customer can retry. Delhivery classifies its own
   * failures — a permanent one (the parcel has already been collected) is a
   * genuine 409, while an unreachable API is a temporary 503 rather than a
   * business rule.
   */
  // Every shipment row, not one: a re-attempted booking leaves a second
  // waybill behind, and maybeSingle() would return null for that order and
  // skip the courier cancellation altogether.
  const { data: shipmentRows } = await supabaseAdmin
    .from("shipments")
    .select("id, waybill, create_response")
    .eq("order_id", id)
    .neq("status", "Cancelled");

  type ShipmentRow = { id: string; waybill: string | null; create_response: unknown };
  const stoppedShipments: string[] = [];
  for (const shipment of (shipmentRows ?? []) as ShipmentRow[]) {
    const waybill = shipment.waybill ?? undefined;
    if (!waybill) continue;

    // A row Delhivery never acknowledged was never really booked, so there is
    // no pickup to stop — used below to avoid blocking on a stale row.
    const booked =
      (shipment.create_response as { success?: boolean } | null)?.success === true;
    const cancelled = await delhiveryProvider.cancelShipment({ waybill });

    if (!cancelled.ok) {
      const detail = cancelled.error?.message ?? "";
      // The raw body is the only way to tell these cases apart after the fact,
      // so it is logged in full rather than summarised.
      console.warn(
        `Delhivery cancel failed for order ${id} (waybill ${waybill}): ${detail}`,
        JSON.stringify(cancelled.raw),
      );

      /*
       * cancelShipment reports every non-Success as "permanent", which means
       * "do not retry" — not "the parcel has been collected". Treating the two
       * as the same told customers the courier had their order whenever
       * Delhivery replied anything other than Success, including for a waybill
       * it had never heard of.
       */
      const says = detail.toLowerCase();
      const unknownWaybill =
        says.includes("not found") ||
        says.includes("does not exist") ||
        says.includes("no waybill") ||
        says.includes("invalid waybill");
      const alreadyCancelled = says.includes("already") && says.includes("cancel");
      const inTransit =
        says.includes("picked") ||
        says.includes("transit") ||
        says.includes("dispatched") ||
        says.includes("out for delivery");

      if (inTransit) {
        // The one case where the parcel really is gone.
        throw new ApiError(
          409,
          "This order is already with the courier and can no longer be cancelled. Please refuse the delivery or start a return once it arrives.",
        );
      }

      if (booked && !unknownWaybill && !alreadyCancelled) {
        // Anything else is unresolved. The order stays exactly as it was so
        // nothing is marked cancelled while a live shipment could still go out.
        throw new ApiError(
          503,
          "We couldn't confirm the cancellation with the courier. Please try again in a moment.",
        );
      }

      // A waybill Delhivery does not recognise, one it has already cancelled,
      // or a row it never acknowledged in the first place all mean nothing is
      // going to be collected — so the order can safely be cancelled rather
      // than the customer being blocked forever by a stale shipment row.
    }

    // Recorded, not written yet: the order itself is updated first so that a
    // failure here can never leave the courier cancelled and the order active.
    stoppedShipments.push(shipment.id);
  }

  // COD collects on delivery, so nothing was ever charged.
  const isCod = order.status === "cod_pending";
  const refundStatus = isCod ? "None" : "Initiated";

  const reason = input.customReason?.trim()
    ? `${input.reason}: ${input.customReason.trim()}`
    : input.reason;

  /*
   * The courier has now stopped the parcel, so the order MUST end up cancelled;
   * leaving it active is the one outcome that strands a customer with a
   * cancelled shipment against a live order. A transient write failure is
   * retried once before anything is reported as broken.
   */
  const patch = {
    fulfillment_status: "Cancelled",
    // Keep the payment state in step so revenue/analytics exclude it.
    status: "cancelled",
    cancel_reason: reason,
    cancelled_at: new Date().toISOString(),
    cancelled_by: "customer",
    refund_status: refundStatus,
  };

  let updated: unknown = null;
  let uErr: { message: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await supabaseAdmin
      .from("orders")
      .update(patch)
      .eq("id", id)
      .select("*, items:order_items(*)")
      .single();
    updated = result.data;
    uErr = result.error;
    if (!uErr) break;
    console.warn(`Order cancel write attempt ${attempt} failed for ${id}: ${uErr.message}`);
  }

  if (uErr) {
    // Never leak Postgres/PostgREST internals to a shopper — log the real
    // cause (e.g. "column ... does not exist" when cancel-order.sql hasn't
    // been run yet) and return the customer-facing message.
    console.error("Order cancellation failed:", uErr.message);

    if (stoppedShipments.length) {
      // The parcel is stopped but the order is still live. Record it so the
      // mismatch is visible and recoverable instead of silently persisting.
      console.error(
        `RECONCILE REQUIRED: order ${id} has shipments cancelled at the courier but was not marked cancelled.`,
      );
      await supabaseAdmin
        .from("shipment_jobs")
        .upsert({ order_id: id, kind: "reconcile", state: "queued", last_error: uErr.message }, {
          onConflict: "order_id,kind",
        });
      throw new ApiError(
        500,
        "Your shipment was stopped but we couldn't finish cancelling the order. Our team has been notified — please contact support before reordering.",
      );
    }

    throw new ApiError(500, "Unable to cancel your order. Please try again.");
  }

  // Only once the order is safely cancelled. A failure here is cosmetic: the
  // customer-visible state is already correct.
  if (stoppedShipments.length) {
    const { error: sErr } = await supabaseAdmin
      .from("shipments")
      .update({ status: "Cancelled", updated_at: new Date().toISOString() })
      .in("id", stoppedShipments);
    if (sErr) console.warn(`Shipment rows not marked cancelled for order ${id}:`, sErr.message);
  }

  await restoreInventory((order.items as OrderItemRow[]) ?? []);

  res.json({ success: true, ok: true, message: "Order cancelled.", order: updated });
}

interface OrderItemRow {
  product_handle: string;
  quantity: number;
}

/**
 * Returns the cancelled units to stock. Best-effort: a stock column that hasn't
 * been migrated yet must never fail an otherwise-valid cancellation.
 */
async function restoreInventory(items: OrderItemRow[]): Promise<void> {
  for (const item of items) {
    const { data: product, error } = await supabaseAdmin
      .from("products")
      .select("stock")
      .eq("handle", item.product_handle)
      .maybeSingle();
    if (error || !product) continue;

    const restored = ((product.stock as number) ?? 0) + (item.quantity ?? 0);
    const { error: sErr } = await supabaseAdmin
      .from("products")
      .update({ stock: restored })
      .eq("handle", item.product_handle);
    if (sErr) console.warn("Stock not restored for", item.product_handle, sErr.message);
  }
}

/** GET /api/orders/:id */
export async function getOrder(req: Request, res: Response) {
  const { id } = req.params;
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*, items:order_items(*)")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, `Order not found: ${id}`);

  res.json({ ok: true, data });
}
