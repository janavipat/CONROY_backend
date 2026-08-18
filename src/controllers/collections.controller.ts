import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { adminCollectionSchema, collectionProductsSchema } from "../validators/schemas.js";
import { discountPercent } from "../lib/pricing.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Mirrors PRODUCT_SELECT in products.controller — the two mappers have drifted
 * before, so a change to one belongs in both. The collection join is what lets
 * the storefront filter a listing by collection; without it these routes
 * returned products with no collections at all while /api/products did.
 */
const PRODUCT_SELECT =
  "*, images:product_images(src, alt, position), collections:collection_products(collection_handle)";

type ImageRow = { src: string; alt: string; position: number };
type CollectionRow = { collection_handle: string };

function mapProduct(row: Record<string, unknown>) {
  const images = ((row.images as ImageRow[]) ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(({ src, alt }) => ({ src, alt }));

  // "all" holds every product, so as a filter option it would never narrow
  // anything.
  const collections = ((row.collections as CollectionRow[]) ?? [])
    .map((c) => c.collection_handle)
    .filter((h) => h && h !== "all");

  return {
    collections,
    id: row.id,
    handle: row.handle,
    title: row.title,
    tagline: row.tagline,
    description: row.description,
    color: row.color,
    fit: row.fit,
    price: row.price,
    // Matches the mapper in products.controller.ts — without this the collection
    // grid silently drops the struck-through original price.
    compareAtPrice: row.compare_at_price ?? undefined,
    discountPercent: discountPercent(row.price, row.compare_at_price),
    // Taxonomy — must stay in step with products.controller.ts. These two
    // mappers have drifted before (compareAtPrice above); a field missing here
    // disappears only on listing pages, which is easy to miss.
    productType: (row.product_type as string) ?? "Jeans",
    category: (row.category as string) ?? "Denim",
    standardColor: (row.standard_color as string) ?? undefined,
    isNewIn: Boolean(row.is_new_in),
    newInOrder: (row.new_in_order as number) ?? undefined,
    isBestSeller: Boolean(row.is_best_seller),
    bestSellerOrder: (row.best_seller_order as number) ?? undefined,
    createdAt: row.created_at ?? undefined,
    currency: row.currency,
    sizes: row.sizes ?? [],
    details: row.details ?? [],
    stock: row.stock,
    rating: Number(row.rating),
    reviewCount: row.review_count,
    badge: row.badge ?? undefined,
    weightG: row.weight_g ?? undefined,
    lengthCm: row.length_cm ?? undefined,
    widthCm: row.width_cm ?? undefined,
    heightCm: row.height_cm ?? undefined,
    isShippable: row.is_shippable ?? true,
    images,
  };
}

/** GET /api/collections */
export async function listCollections(_req: Request, res: Response) {
  const { data, error } = await supabaseAdmin.from("collections").select("*").order("handle");
  if (error) throw new ApiError(500, error.message);
  res.json({ ok: true, count: data?.length ?? 0, data });
}

/** GET /api/collections/:handle  (collection + its products) */
export async function getCollection(req: Request, res: Response) {
  const { handle } = req.params;

  const { data: collection, error: cErr } = await supabaseAdmin
    .from("collections")
    .select("*")
    .eq("handle", handle)
    .maybeSingle();
  if (cErr) throw new ApiError(500, cErr.message);
  if (!collection) throw new ApiError(404, `Collection not found: ${handle}`);

  // "all" returns every product; otherwise follow the join table ordering.
  let products: ReturnType<typeof mapProduct>[] = [];

  if (handle === "all") {
    const { data, error } = await supabaseAdmin
      .from("products")
      .select(PRODUCT_SELECT)
      .order("created_at");
    if (error) throw new ApiError(500, error.message);
    products = (data ?? []).map(mapProduct);
  } else {
    const { data: links, error: lErr } = await supabaseAdmin
      .from("collection_products")
      .select("product_handle, position")
      .eq("collection_handle", handle)
      .order("position");
    if (lErr) throw new ApiError(500, lErr.message);

    const handles = (links ?? []).map((l) => l.product_handle);
    if (handles.length) {
      const { data, error } = await supabaseAdmin
        .from("products")
        .select(PRODUCT_SELECT)
        .in("handle", handles);
      if (error) throw new ApiError(500, error.message);
      const byHandle = new Map((data ?? []).map((p) => [p.handle as string, mapProduct(p)]));
      products = handles.map((h) => byHandle.get(h)).filter(Boolean) as typeof products;
    }
  }

  res.json({ ok: true, data: { ...collection, products } });
}

/* ─────────────────────────── Admin: collections ─────────────────────────── */

/** GET /api/admin/collections — all collections + their product counts. */
export async function listAdminCollections(_req: Request, res: Response) {
  const { data: collections, error } = await supabaseAdmin
    .from("collections")
    .select("*")
    .order("title");
  if (error) throw new ApiError(500, error.message);

  // Product counts per collection.
  const { data: links } = await supabaseAdmin
    .from("collection_products")
    .select("collection_handle");
  const counts = new Map<string, number>();
  for (const l of links ?? []) {
    const key = l.collection_handle as string;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const result = (collections ?? []).map((c) => ({
    handle: c.handle,
    title: c.title,
    subtitle: c.subtitle,
    description: c.description,
    image: c.image,
    productCount: c.handle === "all" ? -1 : counts.get(c.handle as string) ?? 0,
  }));

  res.json({ ok: true, count: result.length, data: result });
}

/** POST /api/admin/collections — create a collection. */
export async function createCollection(req: Request, res: Response) {
  const input = adminCollectionSchema.parse(req.body);
  const handle = input.handle?.trim() || slugify(input.title);
  if (!handle) throw new ApiError(400, "Could not derive a handle from the title.");

  const { error } = await supabaseAdmin.from("collections").insert({
    handle,
    title: input.title,
    subtitle: input.subtitle,
    description: input.description,
    image: input.image,
  });
  if (error) {
    if (error.code === "23505") throw new ApiError(409, "A collection with this handle already exists.");
    throw new ApiError(500, error.message);
  }
  res.status(201).json({ ok: true, message: "Collection created.", data: { handle } });
}

/** PUT /api/admin/collections/:handle — update a collection. */
export async function updateCollection(req: Request, res: Response) {
  const { handle } = req.params;
  const input = adminCollectionSchema.parse(req.body);

  const { data, error } = await supabaseAdmin
    .from("collections")
    .update({
      title: input.title,
      subtitle: input.subtitle,
      description: input.description,
      image: input.image,
    })
    .eq("handle", handle)
    .select()
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, `Collection not found: ${handle}`);
  res.json({ ok: true, message: "Collection updated.", data: { handle } });
}

/** DELETE /api/admin/collections/:handle — delete a collection (links cascade). */
export async function deleteCollection(req: Request, res: Response) {
  const { handle } = req.params;
  if (handle === "all") throw new ApiError(400, "The 'all' collection can't be deleted.");
  const { error } = await supabaseAdmin.from("collections").delete().eq("handle", handle);
  if (error) throw new ApiError(500, error.message);
  res.json({ ok: true, message: "Collection deleted." });
}

/** PUT /api/admin/collections/:handle/products — set the collection's products. */
export async function setCollectionProducts(req: Request, res: Response) {
  const { handle } = req.params;
  const { productHandles } = collectionProductsSchema.parse(req.body);

  // Replace the existing membership with the provided ordered list.
  await supabaseAdmin.from("collection_products").delete().eq("collection_handle", handle);
  if (productHandles.length) {
    const rows = productHandles.map((ph, i) => ({
      collection_handle: handle,
      product_handle: ph,
      position: i,
    }));
    const { error } = await supabaseAdmin.from("collection_products").insert(rows);
    if (error) throw new ApiError(500, error.message);
  }
  res.json({ ok: true, message: "Collection products updated.", count: productHandles.length });
}
