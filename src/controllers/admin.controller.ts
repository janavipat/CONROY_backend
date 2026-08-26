import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { uploadProductImage } from "../lib/storage.js";
import { stopShipmentsForOrder, markShipmentsCancelled } from "../lib/shipping/stopShipments.js";
import { retireCreateJob } from "../services/shipping/jobs.js";
import { softDeleteReady } from "../lib/softDelete.js";
import { notifyOrderEvent } from "../lib/orderNotifications.js";
import {
  adminProductSchema,
  updateReturnStatusSchema,
  inventoryUpdateSchema,
} from "../validators/schemas.js";

/**
 * Columns added by supabase/catalog-taxonomy.sql. Stripped from a write when
 * the migration hasn't been applied yet, so saving a product keeps working on
 * an un-migrated database instead of failing with a 500 — the admin form always
 * sends these fields now, so without this, editing any product would break.
 */
const TAXONOMY_COLUMNS = [
  "product_type",
  "category",
  "standard_color",
  "is_new_in",
  "new_in_order",
  "is_best_seller",
  "best_seller_order",
] as const;

/** True when the error means "that column doesn't exist". */
function isMissingColumn(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  return TAXONOMY_COLUMNS.some((c) => err.message?.includes(c));
}

function withoutTaxonomy(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const c of TAXONOMY_COLUMNS) delete out[c];
  return out;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Rounds to a whole number of rupees, never below zero.
 *
 * No product field is required, so price can arrive missing, empty or as a
 * float. `price` is `integer not null check (price >= 0)`, so clamping here is
 * what keeps a partial product saveable instead of failing at the database.
 */
function safePrice(value: number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** Replaces a product's images with the provided list. */
async function setImages(
  productId: string,
  images: { src: string; alt?: string }[],
): Promise<void> {
  await supabaseAdmin.from("product_images").delete().eq("product_id", productId);
  if (images.length) {
    const { error } = await supabaseAdmin.from("product_images").insert(
      images.map((img, i) => ({
        product_id: productId,
        src: img.src,
        alt: img.alt ?? "",
        position: i,
      })),
    );
    if (error) throw new ApiError(500, error.message);
  }
}

/**
 * Best-effort write of the inventory fields (SKU + status). Ignored if the
 * columns don't exist yet — so product CRUD keeps working before inventory.sql
 * has been run.
 */
async function setInventoryFields(handle: string, sku: string, status: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("products")
    .update({ sku: sku || null, status })
    .eq("handle", handle);
  if (error) console.warn("SKU/status not saved (run inventory.sql):", error.message);
}

/**
 * Best-effort write of the shipping fields (weight/dimensions/is_shippable).
 * Ignored if the columns don't exist yet — so product CRUD keeps working
 * before shipping.sql has been run.
 */
async function setShippingFields(
  handle: string,
  input: { weightG?: number | null; lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null; isShippable: boolean },
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("products")
    .update({
      weight_g: input.weightG ?? null,
      length_cm: input.lengthCm ?? null,
      width_cm: input.widthCm ?? null,
      height_cm: input.heightCm ?? null,
      is_shippable: input.isShippable,
    })
    .eq("handle", handle);
  if (error) console.warn("Shipping fields not saved (run shipping.sql):", error.message);
}

/**
 * Replaces a product's collection membership with the provided handles.
 *
 * Only rows for THIS product are touched, so a collection's other members and
 * their ordering are left exactly as the Collections page left them. New links
 * are appended at the end of their collection (position = current max + 1)
 * rather than at 0, which would reshuffle a curated collection.
 *
 * "all" is skipped — it's derived, never a stored link (see getCollection).
 * Best-effort: a missing collection_products table only warns, matching how the
 * SKU/shipping writes degrade on an un-migrated database.
 */
async function setProductCollections(handle: string, collections: string[]): Promise<void> {
  const wanted = [...new Set(collections.map((c) => c.trim()).filter((c) => c && c !== "all"))];

  const { data: current, error: readErr } = await supabaseAdmin
    .from("collection_products")
    .select("collection_handle")
    .eq("product_handle", handle);
  if (readErr) {
    console.warn("Collections not saved (collection_products unavailable):", readErr.message);
    return;
  }

  const existing = new Set((current ?? []).map((r) => r.collection_handle as string));
  const toAdd = wanted.filter((c) => !existing.has(c));
  const toRemove = [...existing].filter((c) => !wanted.includes(c));

  if (toRemove.length) {
    const { error } = await supabaseAdmin
      .from("collection_products")
      .delete()
      .eq("product_handle", handle)
      .in("collection_handle", toRemove);
    if (error) throw new ApiError(500, error.message);
  }

  if (toAdd.length) {
    // One tail position per collection being joined.
    const { data: tails } = await supabaseAdmin
      .from("collection_products")
      .select("collection_handle, position")
      .in("collection_handle", toAdd);
    const nextPos = new Map<string, number>();
    for (const row of tails ?? []) {
      const key = row.collection_handle as string;
      nextPos.set(key, Math.max(nextPos.get(key) ?? 0, ((row.position as number) ?? 0) + 1));
    }

    const { error } = await supabaseAdmin.from("collection_products").insert(
      toAdd.map((c) => ({
        collection_handle: c,
        product_handle: handle,
        position: nextPos.get(c) ?? 0,
      })),
    );
    if (error) throw new ApiError(500, error.message);
  }
}

/** GET /api/admin/products/:handle/collections — the product's collection handles. */
export async function getProductCollections(req: Request, res: Response) {
  const { handle } = req.params;
  const { data, error } = await supabaseAdmin
    .from("collection_products")
    .select("collection_handle")
    .eq("product_handle", handle);
  if (error) throw new ApiError(500, error.message);
  res.json({ ok: true, data: (data ?? []).map((r) => r.collection_handle as string) });
}

/** POST /api/admin/upload — uploads an image to Supabase Storage, returns its URL. */
export async function uploadImage(req: Request, res: Response) {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) throw new ApiError(400, "No file uploaded (field name must be 'file').");

  const seed = Date.now();
  const result = await uploadProductImage(file.buffer, file.originalname, file.mimetype, seed);
  res.status(201).json({ ok: true, data: result });
}

/** POST /api/admin/products — creates a product. */
export async function createProduct(req: Request, res: Response) {
  const input = adminProductSchema.parse(req.body);
  // A product with no name still needs a handle — it's the primary key. Falling
  // back to a generated one keeps an untitled draft saveable; the admin can set
  // a real name later without the handle ever being empty or colliding.
  const handle =
    input.handle?.trim() || slugify(input.title) || `product-${Date.now().toString(36)}`;

  const productRow: Record<string, unknown> = {
    id: handle,
    handle,
    title: input.title,
    tagline: input.tagline,
    description: input.description,
    color: input.color,
    fit: input.fit,
    product_type: input.productType,
    category: input.category,
    standard_color: input.standardColor ?? null,
    is_new_in: input.isNewIn,
    new_in_order: input.newInOrder ?? null,
    is_best_seller: input.isBestSeller,
    best_seller_order: input.bestSellerOrder ?? null,
    price: safePrice(input.price),
    compare_at_price: input.compareAtPrice == null ? null : safePrice(input.compareAtPrice),
    currency: input.currency,
    sizes: input.sizes,
    details: input.details,
    stock: input.stock,
    rating: 5,
    review_count: 0,
    badge: input.badge ?? null,
  };

  let { error: pErr } = await supabaseAdmin.from("products").insert(productRow);
  if (isMissingColumn(pErr)) {
    ({ error: pErr } = await supabaseAdmin.from("products").insert(withoutTaxonomy(productRow)));
    if (!pErr) console.warn("product created without taxonomy — run supabase/catalog-taxonomy.sql");
  }
  if (pErr) {
    if (pErr.code === "23505") throw new ApiError(409, "A product with this handle already exists.");
    throw new ApiError(500, pErr.message);
  }

  await setImages(handle, input.images);
  await setInventoryFields(handle, input.sku, input.status);
  await setShippingFields(handle, input);
  if (input.collections) await setProductCollections(handle, input.collections);
  res.status(201).json({ ok: true, message: "Product created.", data: { handle } });
}

/** PUT /api/admin/products/:handle — updates a product. */
export async function updateProduct(req: Request, res: Response) {
  const { handle } = req.params;
  const input = adminProductSchema.parse(req.body);

  const { data: existing, error: gErr } = await supabaseAdmin
    .from("products")
    .select("id")
    .eq("handle", handle)
    .maybeSingle();
  if (gErr) throw new ApiError(500, gErr.message);
  if (!existing) throw new ApiError(404, `Product not found: ${handle}`);

  const updateRow: Record<string, unknown> = {
    title: input.title,
    tagline: input.tagline,
    description: input.description,
    color: input.color,
    fit: input.fit,
    product_type: input.productType,
    category: input.category,
    standard_color: input.standardColor ?? null,
    is_new_in: input.isNewIn,
    new_in_order: input.newInOrder ?? null,
    is_best_seller: input.isBestSeller,
    best_seller_order: input.bestSellerOrder ?? null,
    price: safePrice(input.price),
    compare_at_price: input.compareAtPrice == null ? null : safePrice(input.compareAtPrice),
    currency: input.currency,
    sizes: input.sizes,
    details: input.details,
    stock: input.stock,
    badge: input.badge ?? null,
  };

  let { error: uErr } = await supabaseAdmin
    .from("products")
    .update(updateRow)
    .eq("handle", handle);
  if (isMissingColumn(uErr)) {
    ({ error: uErr } = await supabaseAdmin
      .from("products")
      .update(withoutTaxonomy(updateRow))
      .eq("handle", handle));
    if (!uErr) console.warn("product saved without taxonomy — run supabase/catalog-taxonomy.sql");
  }
  if (uErr) throw new ApiError(500, uErr.message);

  await setImages(existing.id as string, input.images);
  await setInventoryFields(handle, input.sku, input.status);
  await setShippingFields(handle, input);
  if (input.collections) await setProductCollections(handle, input.collections);
  res.json({ ok: true, message: "Product updated.", data: { handle } });
}

/** DELETE /api/admin/products/:handle — deletes a product (images cascade). */
export async function deleteProduct(req: Request, res: Response) {
  const { handle } = req.params;
  const { error } = await supabaseAdmin.from("products").delete().eq("handle", handle);
  if (error) throw new ApiError(500, error.message);
  res.json({ ok: true, message: "Product deleted." });
}

/* ─────────────────────────── Admin: orders ──────────────────────────────── */

/**
 * How the order was paid for, read from the payment record rather than the
 * status.
 *
 * `status` is overwritten with "cancelled" when a customer cancels, so a
 * cancelled COD order stopped matching "cod_pending" and fell through to
 * "Online" — telling the admin a refund was owed on money that was never
 * collected. `payment_provider` is written only on the Razorpay path, so it
 * survives cancellation and says what actually happened.
 *
 * The status check stays as a fallback for rows written before
 * payments.sql added the column.
 */
function paymentMethodOf(
  status: string,
  paymentProvider?: string | null,
  refundStatus?: string | null,
): string {
  // Written only on the Razorpay path, and never cleared.
  if (paymentProvider) return "Online";
  // A refund only ever exists against money that was actually taken, so any
  // refund state other than "None" means the order was prepaid.
  if (refundStatus && refundStatus !== "None") return "Online";
  if (status === "cod_pending" || status === "cancelled") return "Cash on Delivery";
  // "paid" with no provider recorded: a row written before payments.sql added
  // the column. Money was taken, so it was online.
  return status === "paid" ? "Online" : "Cash on Delivery";
}

/** GET /api/admin/orders — every order with items + customer + payment method. */
export async function listAllOrders(_req: Request, res: Response) {
  let query = supabaseAdmin
    .from("orders")
    .select("*, items:order_items(*)")
    .order("created_at", { ascending: false });
  // Deleted orders live in their own section and must not appear here.
  if (await softDeleteReady()) query = query.is("deleted_at", null);

  const { data, error } = await query;
  if (error) throw new ApiError(500, error.message);

  const orders = await withShipmentState(data ?? []);
  res.json({ ok: true, count: orders.length, data: orders });
}

/**
 * Attaches courier state to a batch of orders, so an order that never reached
 * Delhivery is identifiable from the list itself rather than only from its
 * detail page.
 */
async function withShipmentState(rows: Record<string, unknown>[]) {
  const [{ data: shipments }, { data: jobs }] = await Promise.all([
    supabaseAdmin.from("shipments").select("order_id, waybill, status"),
    supabaseAdmin
      .from("shipment_jobs")
      .select("order_id, kind, state, attempts, last_error")
      .eq("kind", "create"),
  ]);
  const shipmentBy = new Map((shipments ?? []).map((s) => [s.order_id as string, s]));
  const jobBy = new Map((jobs ?? []).map((j) => [j.order_id as string, j]));

  return rows.map((o) =>
    mapAdminOrder(o, shipmentBy.get(o.id as string), jobBy.get(o.id as string)),
  );
}

/** Shared mapper: a raw orders row (with joined items) → admin order shape. */
function mapAdminOrder(
  o: Record<string, unknown>,
  shipment?: Record<string, unknown>,
  job?: Record<string, unknown>,
) {
  const discount = (o.discount as number) ?? 0;
  return {
    id: o.id as string,
    customerName: (o.full_name as string) || null,
    email: o.email as string,
    phone: (o.phone as string) || null,
    shippingAddress: (o.shipping_address as string) || null,
    subtotal: (o.subtotal as number) ?? 0,
    discount,
    total: ((o.subtotal as number) ?? 0) - discount,
    offerCode: (o.offer_code as string) || null,
    currency: (o.currency as string) || "INR",
    status: o.status as string,
    paymentMethod: paymentMethodOf(
      o.status as string,
      o.payment_provider as string | null,
      o.refund_status as string | null,
    ),
    /*
     * Delivery state and the cancellation record.
     *
     * None of this was mapped, so the admin API answered with the payment
     * status and nothing else — the order detail page had no reason, no
     * timestamp, no actor and no refund state to show, and could only infer
     * "cancelled" from the payment status having been overwritten.
     *
     * Kept separate from `status` on purpose: payment and fulfilment are
     * different questions, and a cancelled COD order has a refund status of
     * "None" precisely because nothing was ever collected.
     */
    /*
     * Courier sync state. `shipmentSynced` is the one an operator needs at a
     * glance: false means this order exists here but not at Delhivery.
     */
    waybill: (shipment?.waybill as string) || null,
    shipmentStatus: (shipment?.status as string) || null,
    shipmentJobState: (job?.state as string) || null,
    shipmentJobAttempts: (job?.attempts as number) ?? 0,
    shipmentError: (job?.last_error as string) || null,
    shipmentSynced: Boolean(shipment?.waybill),
    /** Set while the order sits in Deleted Orders; null once restored. */
    deletedAt: (o.deleted_at as string) || null,
    deletedBy: (o.deleted_by as string) || null,
    fulfillmentStatus: (o.fulfillment_status as string) || "Pending",
    refundStatus: (o.refund_status as string) || "None",
    cancelReason: (o.cancel_reason as string) || null,
    cancelledAt: (o.cancelled_at as string) || null,
    cancelledBy: (o.cancelled_by as string) || null,
    createdAt: o.created_at as string,
    items: (o.items as unknown[]) ?? [],
  };
}

/** GET /api/admin/orders/:id — full detail for one order. */
export async function getAdminOrder(req: Request, res: Response) {
  const { id } = req.params;
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*, items:order_items(*)")
    .eq("id", id)
    .single();
  if (error || !data) throw new ApiError(404, "Order not found.");
  res.json({ ok: true, data: mapAdminOrder(data) });
}

/**
 * DELETE /api/admin/orders/:id — moves an order to Deleted Orders.
 *
 * A soft delete: the row stays, with every item, payment reference, refund
 * state, cancellation record and waybill still attached, and simply leaves the
 * working lists. Removing the row outright used to cascade all of that away,
 * which destroyed the only record of what had happened and could not be undone.
 *
 * The courier is still dealt with first, through the same integration the
 * customer cancellation uses — a deleted order must never leave a live booking
 * sitting in Delhivery One. A refusal aborts the delete and changes nothing.
 */
export async function deleteAdminOrder(req: Request, res: Response) {
  const { id } = req.params;

  if (!(await softDeleteReady())) {
    throw new ApiError(
      503,
      "Deleted Orders is not available yet — supabase/soft-delete-orders.sql has not been run.",
    );
  }

  // Fetched first so a second click on an already-deleted order is refused
  // rather than silently succeeding as though it deleted something.
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!order) throw new ApiError(404, "Order not found.");
  if (order.deleted_at) throw new ApiError(409, "This order is already in Deleted Orders.");

  const stop = await stopShipmentsForOrder(id);
  if (stop.blocked) {
    // Nothing has been written; the order is exactly as the admin left it.
    throw new ApiError(
      stop.blocked.status,
      `${stop.blocked.message} The order has not been deleted.`,
    );
  }

  const { error: dErr } = await supabaseAdmin
    .from("orders")
    .update({ deleted_at: new Date().toISOString(), deleted_by: "admin" })
    .eq("id", id);
  if (dErr) {
    console.error(`Admin order delete failed for ${id}:`, dErr.message);
    throw new ApiError(500, "The shipment was stopped but the order could not be deleted.");
  }

  /*
   * The courier released these before the order was touched; recording it is
   * what stops the panel still showing a live waybill, and what makes a second
   * Delete a no-op instead of a second cancellation request to Delhivery.
   */
  await markShipmentsCancelled(stop.stopped);

  // A deleted order must never be picked up by the shipment worker later.
  await retireCreateJob(id, "Order moved to Deleted Orders by an admin.");

  res.json({
    ok: true,
    message: "Order moved to Deleted Orders.",
    shipmentsCancelled: stop.stopped.length,
  });
}

/** GET /api/admin/orders/deleted — the Deleted Orders section. */
export async function listDeletedOrders(_req: Request, res: Response) {
  if (!(await softDeleteReady())) {
    // Nothing can have been soft-deleted yet, so an empty section is correct.
    res.json({ ok: true, count: 0, data: [], available: false });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*, items:order_items(*)")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);

  const orders = await withShipmentState(data ?? []);
  res.json({ ok: true, count: orders.length, data: orders, available: true });
}

/** POST /api/admin/orders/:id/restore — puts a deleted order back. */
export async function restoreAdminOrder(req: Request, res: Response) {
  const { id } = req.params;
  if (!(await softDeleteReady())) {
    throw new ApiError(503, "Deleted Orders is not available yet.");
  }

  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!order) throw new ApiError(404, "Order not found.");
  if (!order.deleted_at) throw new ApiError(409, "This order is not in Deleted Orders.");

  const { error: rErr } = await supabaseAdmin
    .from("orders")
    .update({ deleted_at: null, deleted_by: null })
    .eq("id", id);
  if (rErr) throw new ApiError(500, rErr.message);

  /*
   * Deliberately does NOT re-queue a shipment. The delete cancelled whatever
   * booking existed, and silently re-manifesting a restored order would put a
   * parcel back on a courier without anyone asking for it — the admin can press
   * Ship if that is what they want.
   */
  res.json({ ok: true, message: "Order restored." });
}

/**
 * DELETE /api/admin/orders/:id/permanent — removes the row for good.
 *
 * Only reachable for an order already in Deleted Orders, so this can never be
 * the first thing that happens to a live order. order_items, shipments,
 * shipment_jobs, shipment_scans and returns are all `on delete cascade`, so the
 * row going is enough to clean up after it.
 */
export async function purgeAdminOrder(req: Request, res: Response) {
  const { id } = req.params;
  if (!(await softDeleteReady())) {
    throw new ApiError(503, "Deleted Orders is not available yet.");
  }

  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!order) throw new ApiError(404, "Order not found.");
  if (!order.deleted_at) {
    throw new ApiError(
      409,
      "Delete this order first — only orders in Deleted Orders can be removed permanently.",
    );
  }

  // Belt and braces: the soft delete already stopped the booking, but a row
  // must never be destroyed while the courier still holds a live waybill.
  const stop = await stopShipmentsForOrder(id);
  if (stop.blocked) {
    throw new ApiError(stop.blocked.status, `${stop.blocked.message} The order has not been removed.`);
  }

  const { error: dErr } = await supabaseAdmin.from("orders").delete().eq("id", id);
  if (dErr) throw new ApiError(500, dErr.message);

  res.json({ ok: true, message: "Order permanently deleted." });
}

/* ────────────────────────── Admin: customers ────────────────────────────── */

interface UserRow {
  phone: string;
  email: string | null;
  created_at: string;
}

/** GET /api/admin/customers — signed-up customers + their order count & spend. */
export async function listCustomers(_req: Request, res: Response) {
  const { data: users, error } = await supabaseAdmin
    .from("users")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);

  // Aggregate orders per customer phone. Spend is net of the offer discount —
  // what the customer actually paid — matching how the Accounts page totals
  // revenue. Summing the gross subtotal here would overstate every buyer by
  // whatever the promotion took off.
  let spendQuery = supabaseAdmin.from("orders").select("phone, subtotal, discount");
  if (await softDeleteReady()) spendQuery = spendQuery.is("deleted_at", null);
  const { data: orders } = await spendQuery;
  const stats = new Map<string, { count: number; spent: number }>();
  for (const o of orders ?? []) {
    const key = o.phone as string | null;
    if (!key) continue;
    const cur = stats.get(key) ?? { count: 0, spent: 0 };
    cur.count += 1;
    cur.spent += ((o.subtotal as number) ?? 0) - ((o.discount as number) ?? 0);
    stats.set(key, cur);
  }

  const customers = ((users ?? []) as UserRow[]).map((u) => ({
    phone: u.phone,
    email: u.email,
    joinedAt: u.created_at,
    orderCount: stats.get(u.phone)?.count ?? 0,
    totalSpent: stats.get(u.phone)?.spent ?? 0,
  }));

  res.json({ ok: true, count: customers.length, data: customers });
}

/* ─────────────────────────── Admin: marketing ───────────────────────────── */

/** GET /api/admin/subscribers — newsletter subscribers. */
export async function listSubscribers(_req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from("newsletter_subscribers")
    .select("email, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);

  res.json({
    ok: true,
    count: data?.length ?? 0,
    data: (data ?? []).map((s) => ({ email: s.email, joinedAt: s.created_at })),
  });
}

/* ─────────────────────────── Admin: inventory ───────────────────────────── */

/** GET /api/admin/inventory — every product's stock / SKU / status. */
export async function listInventory(_req: Request, res: Response) {
  // select("*") so this still works before inventory.sql adds sku/status.
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*")
    .order("title");
  if (error) throw new ApiError(500, error.message);

  const items = (data ?? []).map((p) => ({
    id: p.id,
    handle: p.handle,
    title: p.title,
    sku: (p.sku as string) || "",
    stock: (p.stock as number) ?? 0,
    status: (p.status as string) || "active",
    price: p.price,
    currency: p.currency,
  }));

  res.json({ ok: true, count: items.length, data: items });
}

/** PATCH /api/admin/inventory/:handle — update stock / SKU / status. */
export async function updateInventory(req: Request, res: Response) {
  const { handle } = req.params;
  const input = inventoryUpdateSchema.parse(req.body);

  const patch: Record<string, unknown> = {};
  if (input.stock !== undefined) patch.stock = input.stock;
  if (input.sku !== undefined) patch.sku = input.sku || null;
  if (input.status !== undefined) patch.status = input.status;
  if (Object.keys(patch).length === 0) throw new ApiError(400, "Nothing to update.");

  const { data, error } = await supabaseAdmin
    .from("products")
    .update(patch)
    .eq("handle", handle)
    .select("*")
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, `Product not found: ${handle}`);

  res.json({
    ok: true,
    message: "Inventory updated.",
    data: { handle, stock: data.stock, sku: (data.sku as string) ?? "", status: (data.status as string) ?? "active" },
  });
}

/* ─────────────────────────── Admin: dashboard ───────────────────────────── */

/** GET /api/admin/stats — overview metrics for the admin dashboard. */
export async function getStats(_req: Request, res: Response) {
  // Orders (source of revenue + recent activity).
  let statsQuery = supabaseAdmin
    .from("orders")
    .select("*");
  if (await softDeleteReady()) statsQuery = statsQuery.is("deleted_at", null);
  const { data: ordersData } = await statsQuery
    .order("created_at", { ascending: false });
  const orders = ordersData ?? [];

  const netOf = (o: Record<string, unknown>) =>
    ((o.subtotal as number) ?? 0) - ((o.discount as number) ?? 0);

  /*
   * Revenue is what the store actually billed: net of discounts, and excluding
   * cancelled orders — nothing was collected on those, and counting them left
   * the dashboard disagreeing with the Orders page, which already excluded them.
   */
  const revenue = orders
    .filter((o) => o.status !== "cancelled")
    .reduce((sum, o) => sum + netOf(o), 0);
  const paidCount = orders.filter((o) => o.status === "paid").length;
  const codCount = orders.filter((o) => o.status === "cod_pending").length;
  const recentOrders = orders.slice(0, 6).map((o) => ({
    id: o.id,
    customerName: (o.full_name as string) || null,
    email: o.email,
    total: netOf(o),
    status: o.status,
    createdAt: o.created_at,
  }));

  // Product count.
  const { count: productCount } = await supabaseAdmin
    .from("products")
    .select("*", { count: "exact", head: true });

  // Customer count (users table may not exist yet).
  const { count: customerCount } = await supabaseAdmin
    .from("users")
    .select("*", { count: "exact", head: true });

  // Returns (table may not exist yet).
  const { data: returnsData } = await supabaseAdmin.from("returns").select("status");
  const returnCount = returnsData?.length ?? 0;
  const pendingReturns = (returnsData ?? []).filter((r) => r.status === "requested").length;

  // Active offer (table may not exist yet).
  const { data: offer } = await supabaseAdmin
    .from("offers")
    .select("title")
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  res.json({
    ok: true,
    data: {
      revenue,
      orderCount: orders.length,
      paidCount,
      codCount,
      productCount: productCount ?? 0,
      customerCount: customerCount ?? 0,
      returnCount,
      pendingReturns,
      activeOffer: (offer?.title as string) ?? null,
      recentOrders,
    },
  });
}

/* ─────────────────────────── Admin: returns ─────────────────────────────── */

/** GET /api/admin/returns — every return with items + the short order ref. */
export async function listAllReturns(_req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from("returns")
    .select("*, items:return_items(*)")
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);

  const returns = (data ?? []).map((r) => ({
    id: r.id,
    orderId: r.order_id,
    orderRef: String(r.order_id).slice(0, 8).toUpperCase(),
    customerName: (r.full_name as string) || null,
    email: r.email,
    phone: r.phone,
    reason: r.reason,
    resolution: r.resolution,
    status: r.status,
    createdAt: r.created_at,
    items: r.items ?? [],
  }));

  res.json({ ok: true, count: returns.length, data: returns });
}

/**
 * A return moving to this status means money is moving, so the customer gets a
 * WhatsApp update. Only refund resolutions qualify — a replacement never pays
 * anything back, so "approved" on a replacement stays silent.
 *
 *  approved            → refund_initiated  ("we've started your refund")
 *  refunded, completed → refund_completed  ("the money has gone back")
 *
 * requested/rejected/replaced are deliberately absent: nothing has been paid.
 */
function refundEventForReturnStatus(
  status: string,
  resolution: string,
): "refund_initiated" | "refund_completed" | null {
  if (resolution !== "refund") return null;
  if (status === "approved") return "refund_initiated";
  if (status === "refunded" || status === "completed") return "refund_completed";
  return null;
}

/** PATCH /api/admin/returns/:id — updates a return's processing status. */
export async function updateReturnStatus(req: Request, res: Response) {
  const { id } = req.params;
  const { status } = updateReturnStatusSchema.parse(req.body);

  const { data, error } = await supabaseAdmin
    .from("returns")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*, items:return_items(*)")
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, `Return not found: ${id}`);

  // Keep the order's refund_status in step, so the customer's order page and
  // the WhatsApp message agree. Best-effort: an un-migrated database (no
  // cancel-order.sql) must not fail an otherwise-valid status change.
  const refundEvent = refundEventForReturnStatus(status, String(data.resolution ?? ""));
  if (refundEvent && data.order_id) {
    const refundStatus = refundEvent === "refund_completed" ? "Completed" : "Initiated";
    const { error: oErr } = await supabaseAdmin
      .from("orders")
      .update({ refund_status: refundStatus })
      .eq("id", data.order_id);
    if (oErr) console.warn("Order refund_status not updated:", oErr.message);

    // The refund is for the returned lines only, which is usually less than the
    // order total — send that figure, not the order's.
    void notifyOrderEvent(refundEvent, data.order_id as string, {
      amount: returnValue(data as Row),
    });
  }

  res.json({ ok: true, message: "Return status updated.", data });
}

/** DELETE /api/admin/returns/:id — removes a return request (items cascade). */
export async function deleteReturn(req: Request, res: Response) {
  const { id } = req.params;
  const { error } = await supabaseAdmin.from("returns").delete().eq("id", id);
  if (error) throw new ApiError(500, error.message);
  res.json({ ok: true, message: "Return request deleted." });
}

/* ─────────────────────────────── Accounts ───────────────────────────────── */

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Net billed amount for an order = subtotal − discount. */
function orderNet(o: Row): number {
  return num(o.subtotal) - num(o.discount);
}
/** How the order was paid. Razorpay reference ⇒ online, else cash on delivery. */
function paymentMethod(o: Row): string {
  return o.payment_provider === "razorpay" ? "Online (Razorpay)" : "Cash on delivery";
}
/** Human label + paid flag from the order status. */
function paymentState(o: Row): { label: string; paid: boolean } {
  switch (str(o.status)) {
    case "paid":
      return { label: "Paid", paid: true };
    case "refunded":
      return { label: "Refunded", paid: true };
    case "cod_pending":
      return { label: "Unpaid (COD)", paid: false };
    case "cancelled":
      return { label: "Cancelled", paid: false };
    default:
      return { label: "Pending", paid: false };
  }
}
/** Sum of a return's line items (price × qty). */
function returnValue(r: Row): number {
  const items = (r.items as Row[]) ?? [];
  return items.reduce((s, it) => s + num(it.price) * num(it.quantity), 0);
}

const RETURN_SETTLED = new Set(["refunded", "replaced", "completed"]);
const RETURN_PENDING = new Set(["requested", "approved"]);

/**
 * GET /api/admin/accounts — accounting overview:
 *  - summary: total order amount (net revenue), total return amount, split by
 *    paid vs COD, and net margin.
 *  - customers: per-buyer billing + refunds + margin.
 *  - payments: per-order ledger with payment method + paid/unpaid + Razorpay id.
 *  - returns: every return with its refund value.
 * Uses select("*") so it degrades gracefully if optional columns are absent.
 */
export async function getAccounts(_req: Request, res: Response) {
  const { data: ordersRaw } = await supabaseAdmin
    .from("orders")
    .select("*, items:order_items(price, quantity)")
    .order("created_at", { ascending: false });
  const { data: returnsRaw } = await supabaseAdmin
    .from("returns")
    .select("*, items:return_items(price, quantity)")
    .order("created_at", { ascending: false });

  const orders = (ordersRaw ?? []) as Row[];
  const returns = (returnsRaw ?? []) as Row[];
  const currency = str(orders[0]?.currency) || "INR";

  // Revenue is computed on everything except cancelled orders.
  const active = orders.filter((o) => str(o.status) !== "cancelled");

  let grossSales = 0;
  let totalDiscount = 0;
  let paidRevenue = 0;
  let codRevenue = 0;
  let paidCount = 0;
  let codCount = 0;
  for (const o of active) {
    grossSales += num(o.subtotal);
    totalDiscount += num(o.discount);
    const net = orderNet(o);
    const { paid } = paymentState(o);
    if (paid) {
      paidRevenue += net;
      paidCount += 1;
    } else if (o.payment_provider !== "razorpay") {
      codRevenue += net;
      codCount += 1;
    }
  }
  const netRevenue = grossSales - totalDiscount;

  let refundedAmount = 0;
  let pendingRefunds = 0;
  for (const r of returns) {
    const v = returnValue(r);
    if (RETURN_SETTLED.has(str(r.status))) refundedAmount += v;
    else if (RETURN_PENDING.has(str(r.status))) pendingRefunds += v;
  }

  // Per-customer aggregation (keyed by phone, else email).
  interface Cust {
    name: string | null;
    email: string;
    phone: string | null;
    orderCount: number;
    grossSpent: number;
    discount: number;
    netSpent: number;
    refunded: number;
    lastOrderAt: string;
  }
  const custMap = new Map<string, Cust>();
  for (const o of active) {
    const key = str(o.phone) || str(o.email) || "guest";
    const net = orderNet(o);
    const created = str(o.created_at);
    const c =
      custMap.get(key) ??
      ({
        name: str(o.full_name) || null,
        email: str(o.email),
        phone: str(o.phone) || null,
        orderCount: 0,
        grossSpent: 0,
        discount: 0,
        netSpent: 0,
        refunded: 0,
        lastOrderAt: created,
      } satisfies Cust);
    c.orderCount += 1;
    c.grossSpent += num(o.subtotal);
    c.discount += num(o.discount);
    c.netSpent += net;
    if (!c.name && str(o.full_name)) c.name = str(o.full_name);
    if (created > c.lastOrderAt) c.lastOrderAt = created;
    custMap.set(key, c);
  }
  for (const r of returns) {
    if (!RETURN_SETTLED.has(str(r.status))) continue;
    const key = str(r.phone) || str(r.email) || "guest";
    const c = custMap.get(key);
    if (c) c.refunded += returnValue(r);
  }
  const customers = [...custMap.values()]
    .map((c) => ({ ...c, netMargin: c.netSpent - c.refunded }))
    .sort((a, b) => b.netSpent - a.netSpent);

  const returnsList = returns.map((r) => ({
    id: str(r.id),
    orderRef: str(r.order_id).slice(0, 8).toUpperCase(),
    name: str(r.full_name) || null,
    email: str(r.email),
    phone: str(r.phone) || null,
    resolution: str(r.resolution),
    status: str(r.status),
    reason: str(r.reason),
    value: returnValue(r),
    createdAt: str(r.created_at),
  }));

  // Per-order payment ledger: customer · method · amount · paid/unpaid · ref.
  const payments = orders.map((o) => {
    const state = paymentState(o);
    return {
      id: str(o.id),
      orderRef: str(o.id).slice(0, 8).toUpperCase(),
      name: str(o.full_name) || null,
      email: str(o.email),
      phone: str(o.phone) || null,
      method: paymentMethod(o),
      amount: orderNet(o),
      status: state.label,
      paid: state.paid,
      razorpayPaymentId: str(o.razorpay_payment_id) || null,
      createdAt: str(o.created_at),
    };
  });

  res.json({
    ok: true,
    data: {
      summary: {
        buyerCount: custMap.size,
        orderCount: active.length,
        grossSales,
        totalDiscount,
        netRevenue,
        paidRevenue,
        codRevenue,
        paidCount,
        codCount,
        avgOrderValue: active.length ? Math.round(netRevenue / active.length) : 0,
        returnCount: returns.length,
        refundedAmount,
        pendingRefunds,
        netMargin: netRevenue - refundedAmount,
        currency,
      },
      customers,
      payments,
      returns: returnsList,
    },
  });
}
