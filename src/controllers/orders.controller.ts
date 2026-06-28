import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { createOrderSchema } from "../validators/schemas.js";

/** POST /api/orders — creates an order; prices are resolved server-side. */
export async function createOrder(req: Request, res: Response) {
  const input = createOrderSchema.parse(req.body);

  // Resolve authoritative product data from the DB (never trust client prices).
  const handles = [...new Set(input.items.map((i) => i.productHandle))];
  const { data: products, error: pErr } = await supabaseAdmin
    .from("products")
    .select("handle, title, fit, price, currency, sizes")
    .in("handle", handles);
  if (pErr) throw new ApiError(500, pErr.message);

  const byHandle = new Map((products ?? []).map((p) => [p.handle as string, p]));

  const lineItems = input.items.map((item) => {
    const product = byHandle.get(item.productHandle);
    if (!product) throw new ApiError(400, `Unknown product: ${item.productHandle}`);
    if (!(product.sizes as string[]).includes(item.size)) {
      throw new ApiError(400, `Size ${item.size} is unavailable for ${product.title}`);
    }
    return {
      product_handle: item.productHandle,
      title: product.title as string,
      size: item.size,
      fit: product.fit as string,
      price: product.price as number,
      quantity: item.quantity,
    };
  });

  const currency = (products?.[0]?.currency as string) ?? "INR";
  const subtotal = lineItems.reduce((sum, li) => sum + li.price * li.quantity, 0);

  // Create the order header.
  const { data: order, error: oErr } = await supabaseAdmin
    .from("orders")
    .insert({
      email: input.email,
      full_name: input.fullName ?? null,
      phone: input.phone ?? null,
      shipping_address: input.shippingAddress ?? null,
      subtotal,
      currency,
      status: "pending",
    })
    .select()
    .single();
  if (oErr) throw new ApiError(500, oErr.message);

  // Insert the line items.
  const { error: iErr } = await supabaseAdmin
    .from("order_items")
    .insert(lineItems.map((li) => ({ ...li, order_id: order.id })));
  if (iErr) {
    // Roll back the header if items fail.
    await supabaseAdmin.from("orders").delete().eq("id", order.id);
    throw new ApiError(500, iErr.message);
  }

  res.status(201).json({
    ok: true,
    message: "Order placed successfully.",
    data: { ...order, items: lineItems },
  });
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
