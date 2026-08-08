import type { Request, Response } from "express";
import { z } from "zod";
import { recordPing, snapshot } from "../lib/liveVisitors.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { recordCartEvent, readCartEvents } from "../lib/cartEvents.js";
import { ApiError } from "../middleware/errors.js";

const pingSchema = z.object({
  sessionId: z.string().min(1).max(120),
  path: z.string().max(300).optional(),
  tz: z.string().max(100).optional(),
  locale: z.string().max(35).optional(),
});

/** POST /api/track — public heartbeat from storefront visitors. */
/**
 * Longest slice of time a single page view may contribute to engagement
 * metrics. A tab left open overnight was reporting 21 hours on one view, which
 * inflated total/average session time far beyond reality.
 */
const MAX_VIEW_MS = 30 * 60 * 1000;

/** Admin-facing label for a raw order status (charts shouldn't show DB codes). */
function orderStatusLabel(status: string): string {
  switch (status) {
    case "paid":
      return "Paid";
    case "cod_pending":
      return "Cash on delivery";
    case "cancelled":
      return "Cancelled";
    case "pending":
      return "Pending";
    default:
      return status;
  }
}

export async function trackVisit(req: Request, res: Response) {
  const ping = pingSchema.parse(req.body);
  recordPing(ping);
  res.json({ ok: true });
}

/** GET /api/admin/live — live-visitor snapshot for the admin dashboard. */
export async function getLiveVisitors(_req: Request, res: Response) {
  res.json({ ok: true, data: snapshot() });
}

/* ─────────────────────── Persisted analytics events ─────────────────────── */

const pageViewSchema = z.object({
  sessionId: z.string().min(1).max(120),
  path: z.string().min(1).max(300),
  durationMs: z.coerce.number().int().nonnegative().max(86_400_000).default(0),
  // Present when the visitor is signed in — lets the admin replay one
  // customer's journey rather than an anonymous session.
  phone: z.string().max(40).optional(),
  email: z.string().max(160).optional(),
});

const cartAddSchema = z.object({
  sessionId: z.string().min(1).max(120),
  productHandle: z.string().min(1).max(160),
  phone: z.string().max(40).optional(),
  email: z.string().max(160).optional(),
  // What was actually added. `price` is captured at add-time so later price
  // changes never rewrite the history.
  size: z.string().max(24).optional(),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  price: z.coerce.number().int().nonnegative().optional(),
  currency: z.string().max(8).default("INR"),
});

/**
 * Inserts `full`; if the newer columns aren't there yet (customer-activity.sql
 * not applied), retries with `base` so the row is still recorded rather than
 * lost entirely. Analytics must never fail loudly.
 */
async function insertWithFallback(
  table: "page_views" | "cart_adds",
  full: Record<string, unknown>,
  base: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdmin.from(table).insert(full);
  if (!error) return;
  // 42703 = undefined_column, PGRST204 = column not in schema cache.
  if (error.code === "42703" || error.code === "PGRST204") {
    const { error: retry } = await supabaseAdmin.from(table).insert(base);
    if (retry) console.warn(`${table} not stored:`, retry.message);
    else console.warn(`${table}: stored without the newer columns — run supabase/customer-activity.sql`);
    return;
  }
  console.warn(`${table} not stored (run analytics.sql):`, error.message);
}

/** POST /api/analytics/pageview — records a page view + time-on-page. */
export async function recordPageView(req: Request, res: Response) {
  const input = pageViewSchema.parse(req.body);
  const base = { session_id: input.sessionId, path: input.path, duration_ms: input.durationMs };
  await insertWithFallback(
    "page_views",
    { ...base, phone: input.phone ?? null, email: input.email ?? null },
    base,
  );
  res.json({ ok: true });
}

/** POST /api/analytics/cart-add — records an add-to-cart for a product. */
export async function recordCartAdd(req: Request, res: Response) {
  const input = cartAddSchema.parse(req.body);
  const base = { session_id: input.sessionId, product_handle: input.productHandle };
  await insertWithFallback(
    "cart_adds",
    {
      ...base,
      phone: input.phone ?? null,
      email: input.email ?? null,
      size: input.size ?? null,
      quantity: input.quantity,
      price: input.price ?? null,
      currency: input.currency,
    },
    base,
  );

  // Attribute to a signed-in customer in Storage (no migration needed) so the
  // admin can see customer-wise abandoned carts. Fire-and-forget.
  if (input.phone) {
    void recordCartEvent({
      phone: input.phone,
      email: input.email || "",
      handle: input.productHandle,
      at: new Date().toISOString(),
    });
  }
  res.json({ ok: true });
}

/* ────────────────────── Admin: one customer's activity ──────────────────── */

/** Human label for a storefront path. Product pages get their title upstream. */
function pageLabel(path: string): string {
  const clean = path.split("?")[0].replace(/\/$/, "") || "/";
  if (clean === "/") return "Home page";
  if (clean === "/collections/all") return "Collection";
  if (clean.startsWith("/collections/")) return `Collection: ${clean.slice(13)}`;
  if (clean === "/cart") return "Cart";
  if (clean.startsWith("/checkout")) return "Checkout";
  if (clean === "/search") return "Search";
  if (clean === "/about") return "About us";
  if (clean === "/contact") return "Contact";
  if (clean === "/policy") return "Store policy";
  if (clean === "/terms") return "Terms & conditions";
  if (clean.startsWith("/account")) return `Account${clean.slice(8) ? ` · ${clean.slice(9)}` : ""}`;
  if (clean.startsWith("/products/")) return `Product: ${clean.slice(10)}`;
  return clean;
}

/**
 * GET /api/admin/customers/:phone/activity
 *
 * Everything that customer did, newest first — pages visited with time spent,
 * and every add-to-cart with the product, size, quantity and the price at the
 * time. Add-to-cart is read from `cart_adds`, never from orders, so items that
 * were never purchased still appear.
 */
export async function customerActivity(req: Request, res: Response) {
  const phone = decodeURIComponent(req.params.phone ?? "");
  if (!phone) throw new ApiError(400, "A customer phone is required.");

  // The email on file, so activity recorded before/without a phone still matches.
  const { data: user } = await supabaseAdmin
    .from("users")
    .select("email")
    .eq("phone", phone)
    .maybeSingle();
  const email = (user?.email as string | undefined) ?? null;

  // Match on phone, or on the account email when we have one — activity
  // recorded before a phone was attached still belongs to this customer.
  const filter = email ? `phone.eq.${phone},email.eq.${email}` : `phone.eq.${phone}`;

  const viewsQuery = supabaseAdmin
    .from("page_views")
    .select("path, duration_ms, created_at")
    .or(filter)
    .order("created_at", { ascending: false })
    .limit(500);

  const addsQuery = supabaseAdmin
    .from("cart_adds")
    .select("product_handle, size, quantity, price, currency, created_at")
    .or(filter)
    .order("created_at", { ascending: false })
    .limit(500);

  const [views, adds] = await Promise.all([viewsQuery, addsQuery]);

  // Resolve product titles + images once, for both the cart adds and any
  // /products/<handle> page views, so the UI can show a name not a URL.
  const viewedHandles = ((views.data ?? []) as { path: string }[])
    .map((v) => /^\/products\/([^/?#]+)/.exec(v.path)?.[1])
    .filter((h): h is string => Boolean(h));
  const handles = [
    ...new Set([
      ...((adds.data ?? []) as { product_handle: string }[]).map((a) => a.product_handle),
      ...viewedHandles,
    ]),
  ];
  const products = handles.length
    ? (
        await supabaseAdmin
          .from("products")
          .select("handle, title, price, currency, images:product_images(src, alt, position)")
          .in("handle", handles)
      ).data ?? []
    : [];

  type ImageRow = { src: string; position: number };
  const byHandle = new Map(
    (products as { handle: string; title: string; price: number; currency: string; images?: ImageRow[] }[]).map(
      (p) => [
        p.handle,
        {
          title: p.title,
          price: p.price,
          currency: p.currency,
          image:
            (p.images ?? []).slice().sort((a, b) => a.position - b.position)[0]?.src ?? null,
        },
      ],
    ),
  );

  res.json({
    ok: true,
    data: {
      pageViews: ((views.data ?? []) as Record<string, unknown>[]).map((v) => {
        const path = v.path as string;
        const handle = /^\/products\/([^/?#]+)/.exec(path)?.[1];
        const title = handle ? byHandle.get(handle)?.title : undefined;
        return {
          path,
          label: title ? `Product: ${title}` : pageLabel(path),
          durationMs: Math.min((v.duration_ms as number) ?? 0, MAX_VIEW_MS),
          at: v.created_at as string,
        };
      }),
      cartAdds: ((adds.data ?? []) as Record<string, unknown>[]).map((a) => {
        const p = byHandle.get(a.product_handle as string);
        return {
          handle: a.product_handle as string,
          title: p?.title ?? (a.product_handle as string),
          image: p?.image ?? null,
          size: (a.size as string | null) ?? null,
          quantity: (a.quantity as number | null) ?? 1,
          // Fall back to the catalogue price for rows added before the
          // migration, when nothing was captured at add-time.
          price: (a.price as number | null) ?? p?.price ?? null,
          currency: (a.currency as string | null) ?? p?.currency ?? "INR",
          at: a.created_at as string,
        };
      }),
      // Surfaced so the admin UI can explain an empty list rather than
      // implying the customer did nothing.
      migrationApplied: !(views.error?.code === "42703" || adds.error?.code === "42703"),
    },
  });
}

/**
 * GET /api/admin/abandoned — customer-wise abandoned carts: signed-in shoppers
 * who added a product to their cart but never purchased it. Cart adds made
 * while logged out (no phone) can't be attributed, so they're excluded.
 */
export async function getAbandonedCustomers(_req: Request, res: Response) {
  const { data: products } = await supabaseAdmin.from("products").select("handle, title");
  const titleOf = new Map((products ?? []).map((p) => [p.handle as string, p.title as string]));

  // Attributed add-to-cart events (Storage-backed, no migration needed).
  const adds = await readCartEvents();

  const { data: orders } = await supabaseAdmin
    .from("orders")
    .select("phone, email, full_name, items:order_items(product_handle)");

  // What each customer (by phone) has actually purchased.
  const purchased = new Map<string, Set<string>>();
  const nameByPhone = new Map<string, string>();
  const emailByPhone = new Map<string, string>();
  for (const o of orders ?? []) {
    const phone = (o.phone as string) || "";
    if (!phone) continue;
    if (!purchased.has(phone)) purchased.set(phone, new Set());
    const set = purchased.get(phone)!;
    for (const it of (o.items as { product_handle: string }[]) ?? []) set.add(it.product_handle);
    if (o.full_name && !nameByPhone.has(phone)) nameByPhone.set(phone, o.full_name as string);
    if (o.email && !emailByPhone.has(phone)) emailByPhone.set(phone, o.email as string);
  }

  // Group attributed cart events by customer, keeping products they never bought.
  interface Group {
    phone: string;
    email: string;
    name: string | null;
    handles: Set<string>;
    lastAddedAt: string;
  }
  const groups = new Map<string, Group>();
  for (const a of adds) {
    const phone = a.phone || "";
    if (!phone) continue;
    const handle = a.handle;
    if (purchased.get(phone)?.has(handle)) continue; // they bought this one
    const created = a.at || "";
    const g =
      groups.get(phone) ??
      ({
        phone,
        email: a.email || emailByPhone.get(phone) || "",
        name: nameByPhone.get(phone) ?? null,
        handles: new Set<string>(),
        lastAddedAt: created,
      } as Group);
    g.handles.add(handle);
    if (created > g.lastAddedAt) g.lastAddedAt = created;
    groups.set(phone, g);
  }

  const customers = [...groups.values()]
    .filter((g) => g.handles.size > 0)
    .map((g) => ({
      phone: g.phone,
      email: g.email,
      name: g.name,
      products: [...g.handles].map((h) => ({ handle: h, title: titleOf.get(h) ?? h })),
      productCount: g.handles.size,
      hasOrders: purchased.has(g.phone),
      lastAddedAt: g.lastAddedAt,
    }))
    .sort((a, b) => b.lastAddedAt.localeCompare(a.lastAddedAt));

  res.json({ ok: true, data: customers });
}

/* ────────────────────────── Admin analytics ─────────────────────────────── */

function paymentStatusLabel(status: string): string {
  switch (status) {
    case "paid":
      return "Paid";
    case "cod_pending":
      return "COD · unpaid";
    case "cancelled":
      return "Cancelled";
    case "refunded":
      return "Refunded";
    default:
      return "Pending";
  }
}
function deliveryStatusLabel(status: string): string {
  return status === "cancelled" ? "Cancelled" : "Processing";
}

interface OrderRow {
  id: string;
  date: string;
  products: { title: string; quantity: number }[];
  quantity: number;
  amount: number;
  paymentStatus: string;
  deliveryStatus: string;
}
interface ReturnRow {
  id: string;
  orderId: string;
  date: string;
  products: { title: string; quantity: number }[];
  reason: string;
  refundAmount: number;
  refundStatus: string;
}
interface Customer {
  key: string;
  name: string;
  email: string;
  phone: string | null;
  orders: number;
  items: number;
  grossValue: number;
  returnedAmount: number;
  lastOrder: string;
  orderList: OrderRow[];
  returnList: ReturnRow[];
}

/**
 * GET /api/admin/analytics — full SaaS analytics: KPI summary, chart series,
 * store-wide page activity, and a per-customer breakdown with nested order +
 * return history (net purchase = gross − returned).
 */
export async function getAnalytics(_req: Request, res: Response) {
  const { data: products } = await supabaseAdmin.from("products").select("handle, title");
  const titleOf = new Map((products ?? []).map((p) => [p.handle as string, p.title as string]));

  const { data: views } = await supabaseAdmin
    .from("page_views")
    .select("path, duration_ms, session_id, created_at")
    .order("created_at", { ascending: false })
    .limit(10000);

  const { data: adds } = await supabaseAdmin.from("cart_adds").select("product_handle");
  const { data: purchased } = await supabaseAdmin.from("order_items").select("product_handle");
  const { data: likes } = await supabaseAdmin.from("product_likes").select("product_handle");

  const { data: orders } = await supabaseAdmin
    .from("orders")
    .select(
      "id, email, phone, full_name, subtotal, discount, status, created_at, items:order_items(product_handle, title, size, fit, price, quantity)",
    )
    .order("created_at", { ascending: false });

  const { data: returns } = await supabaseAdmin
    .from("returns")
    .select("id, order_id, phone, email, reason, resolution, status, created_at, items:return_items(title, price, quantity)")
    .order("created_at", { ascending: false });

  /* ── Page activity + sessions ── */
  const pageAgg = new Map<string, { views: number; totalMs: number; sessions: Set<string>; lastVisit: string }>();
  const sessionAgg = new Map<string, { count: number; totalMs: number }>();
  let totalTimeMs = 0;
  for (const v of views ?? []) {
    const path = v.path as string;
    const sid = v.session_id as string;
    // Clamp idle tabs so they don't masquerade as engagement.
    const dur = Math.min((v.duration_ms as number) ?? 0, MAX_VIEW_MS);
    totalTimeMs += dur;
    const p = pageAgg.get(path) ?? { views: 0, totalMs: 0, sessions: new Set<string>(), lastVisit: "" };
    p.views += 1;
    p.totalMs += dur;
    p.sessions.add(sid);
    if ((v.created_at as string) > p.lastVisit) p.lastVisit = v.created_at as string;
    pageAgg.set(path, p);
    const s = sessionAgg.get(sid) ?? { count: 0, totalMs: 0 };
    s.count += 1;
    s.totalMs += dur;
    sessionAgg.set(sid, s);
  }
  const topPages = [...pageAgg.entries()]
    .map(([path, a]) => ({
      path,
      views: a.views,
      uniqueVisitors: a.sessions.size,
      avgSeconds: a.views ? Math.round(a.totalMs / a.views / 1000) : 0,
    }))
    .sort((x, y) => y.views - x.views)
    .slice(0, 15);
  const pageActivity = [...pageAgg.entries()]
    .map(([path, a]) => ({
      path,
      visits: a.views,
      uniqueVisitors: a.sessions.size,
      totalSec: Math.round(a.totalMs / 1000),
      lastVisit: a.lastVisit,
    }))
    .sort((x, y) => y.visits - x.visits)
    .slice(0, 12);

  const totalSessions = sessionAgg.size;
  const bounced = [...sessionAgg.values()].filter((s) => s.count <= 1).length;

  /* ── Products: abandoned + most-liked ── */
  const addCount = new Map<string, number>();
  for (const a of adds ?? []) addCount.set(a.product_handle as string, (addCount.get(a.product_handle as string) ?? 0) + 1);
  const buyCount = new Map<string, number>();
  for (const p of purchased ?? []) buyCount.set(p.product_handle as string, (buyCount.get(p.product_handle as string) ?? 0) + 1);
  const abandoned = [...addCount.entries()]
    .map(([handle, added]) => ({
      handle,
      title: titleOf.get(handle) ?? handle,
      added,
      purchased: buyCount.get(handle) ?? 0,
      notBought: Math.max(0, added - (buyCount.get(handle) ?? 0)),
    }))
    .filter((r) => r.notBought > 0)
    .sort((x, y) => y.notBought - x.notBought)
    .slice(0, 12);
  const likeCount = new Map<string, number>();
  for (const l of likes ?? []) likeCount.set(l.product_handle as string, (likeCount.get(l.product_handle as string) ?? 0) + 1);
  const mostLiked = [...likeCount.entries()]
    .map(([handle, count]) => ({ handle, title: titleOf.get(handle) ?? handle, likes: count }))
    .sort((x, y) => y.likes - x.likes)
    .slice(0, 12);

  /* ── Orders → customers, revenue, charts ── */
  const netOf = (o: Record<string, unknown>) => ((o.subtotal as number) ?? 0) - ((o.discount as number) ?? 0);
  const custMap = new Map<string, Customer>();
  let totalRevenue = 0;
  const statusCount: Record<string, number> = {};

  // Last 14 days buckets for the charts.
  const today = new Date();
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const revByDay = new Map(days.map((d) => [d, 0]));
  const ordByDay = new Map(days.map((d) => [d, 0]));

  for (const o of orders ?? []) {
    const net = netOf(o);
    totalRevenue += net;
    const st = orderStatusLabel(o.status as string);
    statusCount[st] = (statusCount[st] ?? 0) + 1;
    const day = new Date(o.created_at as string).toISOString().slice(0, 10);
    if (revByDay.has(day)) {
      revByDay.set(day, (revByDay.get(day) ?? 0) + net);
      ordByDay.set(day, (ordByDay.get(day) ?? 0) + 1);
    }
    const items = (o.items as { title: string; quantity: number }[]) ?? [];
    const qty = items.reduce((s, i) => s + i.quantity, 0);
    const orderRow: OrderRow = {
      id: o.id as string,
      date: o.created_at as string,
      products: items.map((i) => ({ title: i.title, quantity: i.quantity })),
      quantity: qty,
      amount: net,
      paymentStatus: paymentStatusLabel(st),
      deliveryStatus: deliveryStatusLabel(st),
    };
    const key = (o.phone as string) || (o.email as string) || "guest";
    const c = custMap.get(key);
    if (c) {
      c.orders += 1;
      c.grossValue += net;
      c.items += qty;
      if ((o.created_at as string) > c.lastOrder) c.lastOrder = o.created_at as string;
      c.orderList.push(orderRow);
    } else {
      custMap.set(key, {
        key,
        name: (o.full_name as string) || (o.email as string) || "Guest",
        email: (o.email as string) || "",
        phone: (o.phone as string) || null,
        orders: 1,
        items: qty,
        grossValue: net,
        returnedAmount: 0,
        lastOrder: o.created_at as string,
        orderList: [orderRow],
        returnList: [],
      });
    }
  }

  /* ── Returns → attach to customers ── */
  let totalReturned = 0;
  for (const r of returns ?? []) {
    const items = (r.items as { title: string; price: number; quantity: number }[]) ?? [];
    const refund = items.reduce((s, i) => s + i.price * i.quantity, 0);
    totalReturned += refund;
    const key = (r.phone as string) || (r.email as string) || "guest";
    const retRow: ReturnRow = {
      id: r.id as string,
      orderId: r.order_id as string,
      date: r.created_at as string,
      products: items.map((i) => ({ title: i.title, quantity: i.quantity })),
      reason: r.reason as string,
      refundAmount: refund,
      refundStatus: r.status as string,
    };
    const c = custMap.get(key);
    if (c) {
      c.returnedAmount += refund;
      c.returnList.push(retRow);
    }
  }

  const customers = [...custMap.values()]
    .map((c) => ({
      ...c,
      netPurchase: c.grossValue - c.returnedAmount,
      avgOrder: c.orders ? Math.round(c.grossValue / c.orders) : 0,
    }))
    .sort((a, b) => b.grossValue - a.grossValue)
    .slice(0, 200);

  const totalOrders = (orders ?? []).length;
  const totalRevenueNet = totalRevenue - totalReturned;

  res.json({
    ok: true,
    data: {
      summary: {
        totalCustomers: custMap.size,
        totalOrders,
        totalRevenue,
        totalReturned,
        netRevenue: totalRevenueNet,
        avgOrderValue: totalOrders ? Math.round(totalRevenue / totalOrders) : 0,
        totalVisitors: totalSessions,
        totalPageViews: (views ?? []).length,
        totalTimeSec: Math.round(totalTimeMs / 1000),
        avgSessionSec: totalSessions ? Math.round(totalTimeMs / totalSessions / 1000) : 0,
        bounceRate: totalSessions ? Math.round((bounced / totalSessions) * 100) : 0,
      },
      revenueByDay: days.map((d) => ({ date: d, value: revByDay.get(d) ?? 0 })),
      ordersByDay: days.map((d) => ({ date: d, count: ordByDay.get(d) ?? 0 })),
      statusBreakdown: Object.entries(statusCount).map(([status, count]) => ({ status, count })),
      pageActivity,
      customers,
      topPages,
      abandoned,
      mostLiked,
    },
  });
}
