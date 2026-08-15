import { supabaseAdmin } from "./supabase.js";

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
  /**
   * The campaign tier reached, when the standing offer is what applied.
   * `units` is what is actually in the cart; `minUnits` is the threshold that
   * earned the tier, so a three-item cart still reads "Buy 2 → 50% off".
   */
  tier: { percent: number; units: number; minUnits: number } | null;
  /** The next tier still within reach, so the cart can say what unlocks it. */
  nextTier: { unitsNeeded: number; percent: number } | null;
}

/**
 * The standing CONROY promotion — the one advertised in the welcome popup and
 * the homepage strip.
 *
 * It lives here, beside the admin offers, because this module is the single
 * place any discount is decided: the cart quote, COD checkout, the Razorpay
 * order amount and the post-payment verification all call computeDiscount, so
 * defining the tiers here is what keeps the advertised offer, the charged
 * amount and the saved order the same number.
 *
 * It is not a row in `offers` on purpose. That table models one discount at a
 * time — a percentage or a flat amount, optionally behind a code or a minimum
 * — and has no column for "the second one is cheaper". Adding a tiered type
 * would need a migration and admin UI for a promotion that is a brand-level
 * constant, so it is expressed as one instead. Editing these tiers changes the
 * offer everywhere, including what customers are charged.
 *
 * Tiers are ordered richest first; the first one whose threshold is met wins.
 */
export const CONROY_CAMPAIGN = {
  title: "CONROY Offer",
  tiers: [
    { minUnits: 2, percent: 50 },
    { minUnits: 1, percent: 30 },
  ],
} as const;

/**
 * Which cart lines the campaign applies to.
 *
 * Every product today — it is a store-wide promotion. It exists as a function
 * so narrowing it later (a category, a collection, excluding sale stock) is one
 * edit here rather than a hunt through the checkout.
 */
function isEligible(_line: CartLine): boolean {
  return true;
}

/**
 * The standing campaign's discount for a cart.
 *
 * "Units" is total quantity across eligible lines, not the number of distinct
 * products: two of the same jean unlocks the second tier exactly as two
 * different ones do, which is what the cart's quantity stepper implies.
 */
function campaignDiscount(lines: CartLine[]): {
  discount: number;
  percent: number;
  units: number;
  /** The threshold that earned the tier — what "Buy N" refers to. */
  minUnits: number;
  nextTier: { unitsNeeded: number; percent: number } | null;
} {
  const eligible = lines.filter(isEligible);
  const units = eligible.reduce((n, l) => n + l.quantity, 0);
  const base = eligible.reduce((s, l) => s + l.price * l.quantity, 0);

  const tier = CONROY_CAMPAIGN.tiers.find((t) => units >= t.minUnits) ?? null;
  // The cheapest tier above the one reached — what "add one more" would buy.
  const better = [...CONROY_CAMPAIGN.tiers]
    .sort((a, b) => a.minUnits - b.minUnits)
    .find((t) => t.minUnits > units);

  const percent = tier?.percent ?? 0;
  // Whole rupees, and never more than the base it comes off.
  const discount = Math.max(0, Math.min(base, Math.round((base * percent) / 100)));

  return {
    discount,
    percent,
    units,
    minUnits: tier?.minUnits ?? 0,
    nextTier: better ? { unitsNeeded: better.minUnits - units, percent: better.percent } : null,
  };
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
  const admin = await adminOfferDiscount(lines, subtotal, code);

  // An offer the shop has deliberately switched on takes precedence; the
  // standing campaign is the floor everyone gets when none is running. Only
  // one ever applies, so nothing can be discounted twice.
  if (admin.discount > 0) return admin;

  const camp = campaignDiscount(lines);
  return {
    discount: camp.discount,
    total: Math.max(0, subtotal - camp.discount),
    offer:
      camp.discount > 0
        ? // Reported as an all-products offer because that is what it is, and
          // it keeps the public shape unchanged for existing callers. The
          // tier fields below carry what is campaign-specific.
          { id: "conroy-campaign", title: CONROY_CAMPAIGN.title, type: "all_products" }
        : null,
    applied: camp.discount > 0,
    // A coupon offer that wasn't unlocked still says so, so the checkout can
    // keep prompting for the code even while the campaign is applied.
    requiresCode: admin.requiresCode,
    message: camp.discount > 0 ? `${camp.percent}% off your order.` : admin.message,
    code: null,
    tier:
      camp.percent > 0 ? { percent: camp.percent, units: camp.units, minUnits: camp.minUnits } : null,
    nextTier: camp.nextTier,
  };
}

/** The admin-configured offer, if one is active and its conditions are met. */
async function adminOfferDiscount(
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
    tier: null,
    nextTier: null,
  };

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
    tier: null,
    nextTier: null,
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
