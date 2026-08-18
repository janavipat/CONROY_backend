import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { discountPercent } from "../lib/pricing.js";

/**
 * Collections ride along with the product so the storefront can filter by
 * them. They were already stored — `collection_products` has driven the admin
 * and the collection pages since the start — but the public payload never
 * carried them, so a shopper's filter had nothing to read.
 *
 * Joined here rather than fetched per product: one query still returns the
 * whole catalogue, and the storefront filters in memory over what it already
 * has.
 */
const PRODUCT_SELECT =
  "*, images:product_images(src, alt, position), collections:collection_products(collection_handle)";

type ImageRow = { src: string; alt: string; position: number };
type CollectionRow = { collection_handle: string };

/** Shapes a DB row (snake_case) into the storefront's camelCase product. */
function mapProduct(row: Record<string, unknown>) {
  const images = ((row.images as ImageRow[]) ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(({ src, alt }) => ({ src, alt }));

  // "all" is every product by definition, so it would be a filter option that
  // never narrows anything — dropped here rather than in the UI.
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
    // Taxonomy. Defaults match catalog-taxonomy.sql so rows written before it
    // was applied still read as denim rather than blank.
    productType: (row.product_type as string) ?? "Jeans",
    category: (row.category as string) ?? "Denim",
    standardColor: (row.standard_color as string) ?? undefined,
    isNewIn: Boolean(row.is_new_in),
    newInOrder: (row.new_in_order as number) ?? undefined,
    isBestSeller: Boolean(row.is_best_seller),
    bestSellerOrder: (row.best_seller_order as number) ?? undefined,
    // Kept for "Newest" sorting. Deliberately NOT what drives New In.
    createdAt: row.created_at ?? undefined,
    price: row.price,
    compareAtPrice: row.compare_at_price ?? undefined,
    // Derived, never stored: the saving as a whole percent, or absent when
    // there is no real discount to advertise.
    discountPercent: discountPercent(row.price, row.compare_at_price),
    currency: row.currency,
    sizes: row.sizes ?? [],
    details: row.details ?? [],
    stock: row.stock,
    sku: (row.sku as string) ?? "",
    status: (row.status as string) ?? "active",
    rating: Number(row.rating),
    reviewCount: row.review_count,
    badge: row.badge ?? undefined,
    weightG: row.weight_g ?? undefined,
    lengthCm: row.length_cm ?? undefined,
    widthCm: row.width_cm ?? undefined,
    heightCm: row.height_cm ?? undefined,
    // Defaults true for rows written before shipping.sql (every existing
    // product is a physical, shippable one).
    isShippable: row.is_shippable ?? true,
    images,
  };
}

/** GET /api/products?search=&color=&fit= */
export async function listProducts(req: Request, res: Response) {
  const { search, color, fit } = req.query;

  let query = supabaseAdmin.from("products").select(PRODUCT_SELECT).order("created_at");
  if (color) query = query.eq("color", String(color));
  if (fit) query = query.eq("fit", String(fit));

  const { data, error } = await query;
  if (error) throw new ApiError(500, error.message);

  let products = (data ?? []).map(mapProduct);

  if (search) {
    const q = String(search).toLowerCase();
    products = products.filter((p) =>
      [p.title, p.tagline, p.color, p.fit, p.description].join(" ").toLowerCase().includes(q),
    );
  }

  res.json({ ok: true, count: products.length, data: products });
}

/** GET /api/products/:handle */
export async function getProduct(req: Request, res: Response) {
  const { handle } = req.params;
  const { data, error } = await supabaseAdmin
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("handle", handle)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, `Product not found: ${handle}`);

  res.json({ ok: true, data: mapProduct(data) });
}
