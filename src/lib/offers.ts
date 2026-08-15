import { supabaseAdmin } from "./supabase.js";
import { stagingPriceOverride } from "../config/staging.js";

export interface OfferRow {
  id: string;
  title: string;
  type: "all_products" | "product" | "order_above" | "code";
  discount_type: "percent" | "flat";
  discount_value: number;
  product_handle: string | null;
  min_order_amount: number | null;
  code: string | null;
  active: boolean;
  created_at: string;
}

interface CartLine {
  product_handle: string;
  price: number;
  quantity: number;
}

export interface DiscountResult {
  discount: number;
  total: number;
  offer: { id: string; title: string; type: OfferRow["type"] } | null;
  applied: boolean;
  requiresCode: boolean;
  message: string;
  /** The coupon code that was actually applied (persisted on the order). */
  code: string | null;
}

/** The single active offer (only one may be active at a time). Null if none / table missing. */
export async function getActiveOffer(): Promise<OfferRow | null> {
  try {
    const { data } = await supabaseAdmin
      .from("offers")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as OfferRow) ?? null;
  } catch {
    return null; // offers table not created yet
  }
}

/**
 * Computes the discount for a cart against the active offer. Authoritative —
 * always run server-side; never trust a client-sent discount. The optional
 * `code` only matters for a `code`-type offer.
 */
export async function computeDiscount(
  lines: CartLine[],
  subtotal: number,
  code?: string | null,
): Promise<DiscountResult> {
  const none: DiscountResult = {
    discount: 0,
    total: subtotal,
    offer: null,
    applied: false,
    requiresCode: false,
    message: "",
    code: null,
  };

  // Staging with a flat price override: a live "₹200 off" offer applied to a ₹1
  // cart leaves a payable of ₹0, which Razorpay rejects outright — so the test
  // order would fail at the one step the client is here to try. The override is
  // already the test discount; stacking a second one on top buys nothing.
  if (stagingPriceOverride() !== null) return none;

  const offer = await getActiveOffer();
  if (!offer) return none;

  const summary = { id: offer.id, title: offer.title, type: offer.type };
  const pct = offer.discount_type === "percent";
  // Discount never exceeds the base it applies to.
  const calc = (base: number) =>
    Math.max(0, Math.min(base, pct ? Math.round((base * offer.discount_value) / 100) : offer.discount_value));

  const result = (discount: number, message: string, appliedCode: string | null): DiscountResult => ({
    discount,
    total: Math.max(0, subtotal - discount),
    offer: summary,
    applied: discount > 0,
    requiresCode: false,
    message,
    code: appliedCode,
  });

  switch (offer.type) {
    case "code": {
      const match =
        !!code && !!offer.code && code.trim().toUpperCase() === offer.code.trim().toUpperCase();
      if (!match) {
        return { ...none, offer: summary, requiresCode: true, message: "Enter the coupon code to apply this offer." };
      }
      return result(calc(subtotal), `Coupon “${offer.code}” applied.`, offer.code);
    }

    case "order_above": {
      const min = offer.min_order_amount ?? 0;
      if (subtotal < min) {
        return { ...none, offer: summary, message: `Spend ${min} or more to unlock this offer.` };
      }
      return result(calc(subtotal), offer.title, null);
    }

    case "product": {
      const base = lines
        .filter((l) => l.product_handle === offer.product_handle)
        .reduce((s, l) => s + l.price * l.quantity, 0);
      if (base <= 0) return { ...none, offer: summary, message: "This offer applies to a specific product." };
      return result(calc(base), offer.title, null);
    }

    case "all_products":
    default:
      return result(calc(subtotal), offer.title, null);
  }
}
