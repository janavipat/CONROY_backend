import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { uploadProductImage } from "../lib/storage.js";
import {
  adminProductSchema,
  updateReturnStatusSchema,
  inventoryUpdateSchema,
} from "../validators/schemas.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  const handle = input.handle?.trim() || slugify(input.title);
  if (!handle) throw new ApiError(400, "Could not derive a handle from the name.");

  const { error: pErr } = await supabaseAdmin.from("products").insert({
    id: handle,
    handle,
    title: input.title,
    tagline: input.tagline,
    description: input.description,
    color: input.color,
    fit: input.fit,
    price: input.price,
    currency: input.currency,
    sizes: input.sizes,
    details: input.details,
    stock: input.stock,
    rating: 5,
    review_count: 0,
    badge: input.badge ?? null,
  });
  if (pErr) {
    if (pErr.code === "23505") throw new ApiError(409, "A product with this handle already exists.");
    throw new ApiError(500, pErr.message);
  }

  await setImages(handle, input.images);
  await setInventoryFields(handle, input.sku, input.status);
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

  const { error: uErr } = await supabaseAdmin
    .from("products")
    .update({
      title: input.title,
      tagline: input.tagline,
      description: input.description,
      color: input.color,
      fit: input.fit,
      price: input.price,
      currency: input.currency,
      sizes: input.sizes,
      details: input.details,
      stock: input.stock,
      badge: input.badge ?? null,
    })
    .eq("handle", handle);
  if (uErr) throw new ApiError(500, uErr.message);

  await setImages(existing.id as string, input.images);
  await setInventoryFields(handle, input.sku, input.status);
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

function paymentMethodOf(status: string): string {
  return status === "cod_pending" ? "Cash on Delivery" : "Online";
}

/** GET /api/admin/orders — every order with items + customer + payment method. */
export async function listAllOrders(_req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*, items:order_items(*)")
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);

  const orders = (data ?? []).map(mapAdminOrder);

  res.json({ ok: true, count: orders.length, data: orders });
}

/** Shared mapper: a raw orders row (with joined items) → admin order shape. */
function mapAdminOrder(o: Record<string, unknown>) {
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
    paymentMethod: paymentMethodOf(o.status as string),
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

  // Aggregate orders per customer phone.
  const { data: orders } = await supabaseAdmin.from("orders").select("phone, subtotal");
  const stats = new Map<string, { count: number; spent: number }>();
  for (const o of orders ?? []) {
    const key = o.phone as string | null;
    if (!key) continue;
    const cur = stats.get(key) ?? { count: 0, spent: 0 };
    cur.count += 1;
    cur.spent += (o.subtotal as number) ?? 0;
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
  const { data: ordersData } = await supabaseAdmin
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false });
  const orders = ordersData ?? [];

  const netOf = (o: Record<string, unknown>) =>
    ((o.subtotal as number) ?? 0) - ((o.discount as number) ?? 0);

  const revenue = orders.reduce((sum, o) => sum + netOf(o), 0);
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

/** PATCH /api/admin/returns/:id — updates a return's processing status. */
export async function updateReturnStatus(req: Request, res: Response) {
  const { id } = req.params;
  const { status } = updateReturnStatusSchema.parse(req.body);

  const { data, error } = await supabaseAdmin
    .from("returns")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, `Return not found: ${id}`);

  res.json({ ok: true, message: "Return status updated.", data });
}
