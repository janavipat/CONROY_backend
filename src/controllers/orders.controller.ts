import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { cancelOrderSchema, CANCELLABLE_STATUSES } from "../validators/schemas.js";
import { createOrderSchema } from "../validators/schemas.js";
import { resolveCart, persistOrder } from "../lib/pricing.js";
import { computeDiscount } from "../lib/offers.js";

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

  // COD collects on delivery, so nothing was ever charged.
  const isCod = order.status === "cod_pending";
  const refundStatus = isCod ? "None" : "Initiated";

  const reason = input.customReason?.trim()
    ? `${input.reason}: ${input.customReason.trim()}`
    : input.reason;

  const { data: updated, error: uErr } = await supabaseAdmin
    .from("orders")
    .update({
      fulfillment_status: "Cancelled",
      // Keep the payment state in step so revenue/analytics exclude it.
      status: "cancelled",
      cancel_reason: reason,
      cancelled_at: new Date().toISOString(),
      cancelled_by: "customer",
      refund_status: refundStatus,
    })
    .eq("id", id)
    .select("*, items:order_items(*)")
    .single();
  if (uErr) throw new ApiError(500, uErr.message);

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
