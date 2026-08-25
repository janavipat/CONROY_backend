import { supabaseAdmin } from "./supabase.js";
import { ApiError } from "../middleware/errors.js";
import { enqueueCreateShipmentJob, fireShipmentJobNow } from "../services/shipping/jobs.js";

/**
 * How long checkout will wait for the courier before handing the shipment
 * back to the retry queue. Comfortably above a normal manifest (a few
 * seconds) and well inside the platform request budget.
 */
const CHECKOUT_SHIPMENT_WAIT_MS = 10_000;

/**
 * The saving on a product, as a whole percentage of its original price.
 *
 * Lives here rather than in a template so every surface — product grids, the
 * PDP, quick view, search — shows the same figure derived from the same two
 * numbers, and a change to how CONROY expresses a discount happens once.
 *
 * Returns undefined unless there is a real saving: no MRP, an MRP at or below
 * the selling price, or anything non-finite yields no badge rather than "0%
 * Off" or a negative.
 */
export function discountPercent(
  price: unknown,
  compareAtPrice: unknown,
): number | undefined {
  const now = Number(price);
  const was = Number(compareAtPrice);
  if (!Number.isFinite(now) || !Number.isFinite(was)) return undefined;
  if (was <= 0 || was <= now) return undefined;
  const pct = Math.round(((was - now) / was) * 100);
  return pct > 0 ? pct : undefined;
}

export interface OrderLineItem {
  product_handle: string;
  title: string;
  size: string;
  fit: string;
  price: number;
  quantity: number;
}

export interface ResolvedCart {
  lineItems: OrderLineItem[];
  subtotal: number;
  currency: string;
}

interface CartInput {
  productHandle: string;
  size: string;
  quantity: number;
}

/**
 * Resolves cart items against authoritative product data in Supabase and
 * computes the subtotal. Prices, titles and fit are ALWAYS taken from the DB —
 * the client only supplies handle/size/quantity so it can never tamper with
 * what is charged.
 */
export async function resolveCart(items: CartInput[]): Promise<ResolvedCart> {
  const handles = [...new Set(items.map((i) => i.productHandle))];
  const { data: products, error } = await supabaseAdmin
    .from("products")
    .select("handle, title, fit, price, currency, sizes")
    .in("handle", handles);
  if (error) throw new ApiError(500, error.message);

  const byHandle = new Map((products ?? []).map((p) => [p.handle as string, p]));

  const lineItems: OrderLineItem[] = items.map((item) => {
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

  return { lineItems, subtotal, currency };
}

/**
 * Persists an order header + line items. Used by both COD checkout and the
 * post-payment Razorpay verification path. Rolls back the header if the item
 * insert fails.
 *
 * Payment references (Razorpay order/payment id) are stored best-effort in a
 * separate update so the core insert never depends on the payment columns
 * existing — the flow keeps working even before payments.sql has been run.
 */
/**
 * Structured delivery address, as collected by the checkout form. Courier
 * APIs (Delhivery) need these as individual fields — `shippingAddress` is
 * kept purely as the human-readable display string, never reverse-parsed.
 */
export interface ShipAddress {
  name: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  pincode: string;
  country?: string;
}

export async function persistOrder(params: {
  /** Blank when the shopper chose not to give one. Never substituted. */
  email?: string | null;
  fullName?: string | null;
  phone?: string | null;
  shippingAddress?: string | null;
  shipAddress?: ShipAddress | null;
  status: string;
  cart: ResolvedCart;
  discount?: number;
  offerCode?: string | null;
  payment?: {
    provider: string;
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
  } | null;
}) {
  const { cart } = params;

  const { data: order, error: oErr } = await supabaseAdmin
    .from("orders")
    .insert({
      /*
       * orders.email is NOT NULL, so an absent address is stored as an empty
       * string rather than a placeholder — nothing downstream treats it as an
       * identifier, and a fake address would be worse than none.
       */
      email: params.email ?? "",
      full_name: params.fullName ?? null,
      phone: params.phone ?? null,
      shipping_address: params.shippingAddress ?? null,
      subtotal: cart.subtotal,
      currency: cart.currency,
      status: params.status,
    })
    .select()
    .single();
  if (oErr) throw new ApiError(500, oErr.message);

  const { error: iErr } = await supabaseAdmin
    .from("order_items")
    .insert(cart.lineItems.map((li) => ({ ...li, order_id: order.id })));
  if (iErr) {
    await supabaseAdmin.from("orders").delete().eq("id", order.id);
    throw new ApiError(500, iErr.message);
  }

  // Best-effort: store the payment reference. Silently ignored if the payment
  // columns don't exist yet (user hasn't run payments.sql).
  if (params.payment) {
    const { error: payErr } = await supabaseAdmin
      .from("orders")
      .update({
        payment_provider: params.payment.provider,
        razorpay_order_id: params.payment.razorpay_order_id ?? null,
        razorpay_payment_id: params.payment.razorpay_payment_id ?? null,
      })
      .eq("id", order.id);
    if (payErr) {
      console.warn("Payment reference not stored (run payments.sql):", payErr.message);
    }
  }

  // Best-effort: store the structured address. Ignored if shipping.sql not run
  // — checkout must keep working even before the migration is applied.
  let shipFields: Record<string, unknown> = {};
  if (params.shipAddress) {
    const a = params.shipAddress;
    shipFields = {
      ship_name: a.name,
      ship_phone: a.phone,
      ship_line1: a.line1,
      ship_line2: a.line2 || null,
      ship_city: a.city,
      ship_state: a.state,
      ship_pincode: a.pincode,
      ship_country: a.country || "India",
    };
    const { error: shipErr } = await supabaseAdmin.from("orders").update(shipFields).eq("id", order.id);
    if (shipErr) {
      console.warn("Structured address not stored (run shipping.sql):", shipErr.message);
      shipFields = {};
    }
  }

  // Best-effort: store the discount + coupon. Ignored if offers.sql not run.
  let discount = 0;
  if (params.discount && params.discount > 0) {
    discount = params.discount;
    const { error: dErr } = await supabaseAdmin
      .from("orders")
      .update({ discount, offer_code: params.offerCode ?? null })
      .eq("id", order.id);
    if (dErr) {
      console.warn("Discount not stored (run offers.sql):", dErr.message);
      discount = 0;
    }
  }

  /*
   * Auto-ship: paid and COD orders are both confirmed, ready-to-fulfil orders.
   *
   * The attempt is awaited up to a bound rather than left to run loose. Not
   * awaiting it at all is what stranded orders in practice: once checkout has
   * responded the platform freezes the function, so the Delhivery call died
   * part-way and the job sat at 'running' with nothing recording a result —
   * roughly two in five orders never reached the courier. Manifesting normally
   * takes a few seconds, so most orders now have their waybill before the
   * customer sees the confirmation.
   *
   * The bound is what keeps a slow courier from holding checkout open. If it
   * expires the order is still returned immediately and the job is left to the
   * queue, which retries it — the shipment is never lost, only delayed.
   */
  if (params.status === "paid" || params.status === "cod_pending") {
    await enqueueCreateShipmentJob(order.id as string);
    await Promise.race([
      fireShipmentJobNow(order.id as string),
      new Promise((resolve) => setTimeout(resolve, CHECKOUT_SHIPMENT_WAIT_MS)),
    ]);
  }

  return { ...order, ...shipFields, discount, offer_code: params.offerCode ?? null, items: cart.lineItems };
}
