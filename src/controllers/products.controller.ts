import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";

const PRODUCT_SELECT = "*, images:product_images(src, alt, position)";

type ImageRow = { src: string; alt: string; position: number };

/** Shapes a DB row (snake_case) into the storefront's camelCase product. */
function mapProduct(row: Record<string, unknown>) {
  const images = ((row.images as ImageRow[]) ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(({ src, alt }) => ({ src, alt }));

  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    tagline: row.tagline,
    description: row.description,
    color: row.color,
    fit: row.fit,
    price: row.price,
    compareAtPrice: row.compare_at_price ?? undefined,
    currency: row.currency,
    sizes: row.sizes ?? [],
    details: row.details ?? [],
    stock: row.stock,
    sku: (row.sku as string) ?? "",
    status: (row.status as string) ?? "active",
    rating: Number(row.rating),
    reviewCount: row.review_count,
    badge: row.badge ?? undefined,
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
