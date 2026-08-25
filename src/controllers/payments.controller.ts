import type { Request, Response } from "express";
import { ApiError } from "../middleware/errors.js";
import { resolveCart, persistOrder } from "../lib/pricing.js";
import { computeDiscount } from "../lib/offers.js";
import {
  razorpayConfigured,
  createRazorpayOrder,
  verifyRazorpaySignature,
} from "../lib/razorpay.js";
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
 * Verifies the Razorpay signature and, only if valid, persists the order as
 * paid. Prices are re-resolved server-side here too — the order that gets
 * written never trusts client-sent amounts.
 */
export async function verifyPayment(req: Request, res: Response) {
  const input = razorpayVerifySchema.parse(req.body);

  if (!razorpayConfigured) {
    throw new ApiError(400, "Razorpay is not configured on the server.");
  }

  const valid = verifyRazorpaySignature({
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
  });
  if (!valid) throw new ApiError(400, "Payment verification failed. Signature mismatch.");

  const cart = await resolveCart(input.items);
  const offer = await computeDiscount(cart.lineItems, cart.subtotal, input.code);

  const order = await persistOrder({
    email: input.email || "",
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

  res.status(201).json({
    ok: true,
    message: "Payment verified and order placed.",
    data: order,
  });
}
