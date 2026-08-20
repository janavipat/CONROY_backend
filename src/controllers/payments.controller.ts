import type { Request, Response } from "express";
import { ApiError } from "../middleware/errors.js";
import { resolveCart, persistOrder } from "../lib/pricing.js";
import { computeDiscount } from "../lib/offers.js";
import {
  razorpayConfigured,
  createRazorpayOrder,
  verifyRazorpaySignature,
  fetchRazorpayPayment,
} from "../lib/razorpay.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { razorpayOrderSchema, razorpayVerifySchema } from "../validators/schemas.js";

/**
 * POST /api/payments/razorpay/order
 * Creates a Razorpay order for the current cart. The payable amount is resolved
 * server-side from the DB so the client can never influence what is charged.
 * Returns the public key id + Razorpay order id for the Checkout widget.
 *
 * When Razorpay keys aren't configured, responds with { mock: true } so the
 * frontend can fall back to the free demo checkout.
 */
export async function createPaymentOrder(req: Request, res: Response) {
  const { items, code } = razorpayOrderSchema.parse(req.body);
  const cart = await resolveCart(items);

  if (cart.subtotal <= 0) throw new ApiError(400, "Order total must be greater than zero.");

  // Apply the active offer server-side; charge the net amount.
  const offer = await computeDiscount(cart.lineItems, cart.subtotal, code);
  const payable = Math.max(0, cart.subtotal - offer.discount);

  if (!razorpayConfigured) {
    return res.json({
      ok: true,
      mock: true,
      amount: payable * 100,
      currency: cart.currency,
      discount: offer.discount,
      message: "Razorpay not configured — demo checkout.",
    });
  }

  const receipt = `conroy_${Date.now()}`;
  const order = await createRazorpayOrder(payable, cart.currency, receipt);

  res.json({
    ok: true,
    mock: false,
    keyId: env.RAZORPAY_KEY_ID,
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    discount: offer.discount,
  });
}

/**
 * POST /api/payments/razorpay/verify
 *
 * Turns a captured Razorpay payment into an order. Every step logs, because the
 * failure this replaces was silent on the server and showed the customer only
 * "Request failed with status code 400" — after their money had gone.
 *
 * Order of checks, and why:
 *   1. Idempotency first. A refresh, a double-submit or a retry must return the
 *      order that already exists, never a duplicate of it.
 *   2. Signature — proves the callback came from Razorpay, not a forged POST.
 *   3. Razorpay's own record of the payment — proves the money actually moved.
 *      A signature cannot tell us that, so an order is never written on it alone.
 *   4. Only then the order, and only after the order the shipment.
 *
 * If shipment creation later fails the order still stands as paid: persistOrder
 * enqueues the courier job and never lets it fail the write. A paid order with
 * no waybill is recoverable; a captured payment with no order is not.
 */
export async function verifyPayment(req: Request, res: Response) {
  const input = razorpayVerifySchema.parse(req.body);
  const tag = `[payment ${input.razorpayPaymentId}]`;

  if (!razorpayConfigured) {
    console.error(`${tag} rejected: Razorpay is not configured on this deployment.`);
    throw new ApiError(400, "Razorpay is not configured on the server.");
  }

  // 1 ── Signature first, and before ANY read: this callback really came from Razorpay.
  const valid = verifyRazorpaySignature({
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
  });
  if (!valid) {
    console.error(`${tag} SIGNATURE MISMATCH for ${input.razorpayOrderId}. Refusing to read or write an order.`);
    throw new ApiError(400, "Payment verification failed. Signature mismatch.");
  }
  console.log(`${tag} signature ok.`);

  // 2 ── Idempotency, but only for a caller that already proved the callback
  //      is genuine. This response carries the customer's name, phone and
  //      address, so it sits behind the signature check rather than in front
  //      of it — otherwise anyone holding a payment id could read the order by
  //      sending a forged signature. A real retry carries the same valid
  //      signature, so nothing legitimate is lost by the ordering.
  const { data: existing } = await supabaseAdmin
    .from("orders")
    .select("*, items:order_items(*)")
    .eq("razorpay_payment_id", input.razorpayPaymentId)
    .maybeSingle();

  if (existing) {
    console.log(`${tag} already recorded as order ${existing.id} — returning it unchanged.`);
    return res.status(200).json({
      ok: true,
      idempotent: true,
      message: "Payment already verified and order placed.",
      data: existing,
    });
  }

  // 3 ── Razorpay is the source of truth for whether money moved.
  const payment = await fetchRazorpayPayment(input.razorpayPaymentId);
  if (!payment) {
    // Unknown, not "no". Fail loudly rather than write an unfunded order.
    console.error(`${tag} could not be read back from Razorpay — refusing to guess.`);
    throw new ApiError(502, "Could not confirm the payment with Razorpay. Please contact support before retrying.");
  }
  if (payment.status !== "captured" || !payment.captured) {
    console.error(`${tag} not captured (status=${payment.status}). No order written.`);
    throw new ApiError(400, `Payment is not captured (status: ${payment.status}).`);
  }
  if (payment.order_id && payment.order_id !== input.razorpayOrderId) {
    console.error(`${tag} belongs to ${payment.order_id}, not ${input.razorpayOrderId}.`);
    throw new ApiError(400, "Payment does not belong to this order.");
  }
  console.log(`${tag} captured ${payment.amount / 100} ${payment.currency} — proceeding to order.`);

  // 4 ── Price is resolved server-side; the client never says what to charge.
  const cart = await resolveCart(input.items);
  const offer = await computeDiscount(cart.lineItems, cart.subtotal, input.code);
  const payable = Math.max(0, cart.subtotal - offer.discount);
  console.log(`${tag} cart resolved: subtotal ${cart.subtotal}, discount ${offer.discount}, payable ${payable}.`);

  if (Math.round(payable * 100) !== payment.amount) {
    // Not fatal to the order — the money is already taken and the customer must
    // get what they paid for. Loud, because it means pricing moved under a live
    // checkout and someone has to reconcile it.
    console.error(
      `${tag} AMOUNT MISMATCH: charged ${payment.amount / 100}, cart now resolves to ${payable}. Recording the order anyway.`,
    );
  }

  const order = await persistOrder({
    email: input.email,
    fullName: input.fullName,
    phone: input.phone,
    shippingAddress: input.shippingAddress,
    shipAddress: input.shipAddress,
    status: "paid",
    cart,
    discount: offer.discount,
    offerCode: offer.code,
    payment: {
      provider: "razorpay",
      razorpay_order_id: input.razorpayOrderId,
      razorpay_payment_id: input.razorpayPaymentId,
    },
  });

  console.log(`${tag} order ${order.id} written as paid; courier job enqueued.`);

  res.status(201).json({
    ok: true,
    message: "Payment verified and order placed.",
    data: order,
  });
}
