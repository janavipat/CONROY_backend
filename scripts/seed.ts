/**
 * Seeds the Supabase database with the CONROY catalog.
 * Run after applying supabase/schema.sql:  npm run seed
 *
 * Idempotent: upserts products/collections and rebuilds their images/links.
 */
import { supabaseAdmin } from "../src/lib/supabase.js";
import { COLLECTIONS, PRODUCTS } from "../src/data/catalog.js";

async function main() {
  console.log("🌱 Seeding CONROY catalog into Supabase…\n");

  // 1. Products
  const { error: prodErr } = await supabaseAdmin.from("products").upsert(
    PRODUCTS.map((p) => ({
      id: p.id,
      handle: p.handle,
      title: p.title,
      tagline: p.tagline,
      description: p.description,
      color: p.color,
      fit: p.fit,
      price: p.price,
      currency: p.currency,
      sizes: p.sizes,
      details: p.details,
      stock: p.stock,
      rating: p.rating,
      review_count: p.review_count,
      badge: p.badge,
    })),
    { onConflict: "id" },
  );
  if (prodErr) throw prodErr;
  console.log(`✔ products (${PRODUCTS.length})`);

  // 2. Product images — replace per product to stay idempotent.
  for (const p of PRODUCTS) {
    await supabaseAdmin.from("product_images").delete().eq("product_id", p.id);
    const { error } = await supabaseAdmin.from("product_images").insert(
      p.images.map((img, i) => ({
        product_id: p.id,
        src: img.src,
        alt: img.alt,
        position: i,
      })),
    );
    if (error) throw error;
  }
  console.log(`✔ product_images`);

  // 3. Collections
  const { error: colErr } = await supabaseAdmin.from("collections").upsert(
    COLLECTIONS.map((c) => ({
      handle: c.handle,
      title: c.title,
      subtitle: c.subtitle,
      description: c.description,
      image: c.image,
    })),
    { onConflict: "handle" },
  );
  if (colErr) throw colErr;
  console.log(`✔ collections (${COLLECTIONS.length})`);

  // 4. Collection ↔ product links
  for (const c of COLLECTIONS) {
    await supabaseAdmin.from("collection_products").delete().eq("collection_handle", c.handle);
    const { error } = await supabaseAdmin.from("collection_products").insert(
      c.productHandles.map((handle, i) => ({
        collection_handle: c.handle,
        product_handle: handle,
        position: i,
      })),
    );
    if (error) throw error;
  }
  console.log(`✔ collection_products`);

  console.log("\n✅ Seed complete.");
}

main().catch((err) => {
  console.error("\n❌ Seed failed:", err.message ?? err);
  process.exit(1);
});
