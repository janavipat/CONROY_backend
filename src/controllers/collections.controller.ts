import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";

const PRODUCT_SELECT = "*, images:product_images(src, alt, position)";

type ImageRow = { src: string; alt: string; position: number };

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
    currency: row.currency,
    sizes: row.sizes ?? [],
    details: row.details ?? [],
    stock: row.stock,
    rating: Number(row.rating),
    reviewCount: row.review_count,
    badge: row.badge ?? undefined,
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
