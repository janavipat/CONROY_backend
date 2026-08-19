import { supabaseAdmin } from "../src/lib/supabase.js";

/**
 * Clears the test tracking data behind the admin Chat and Analytics panels.
 *
 * Default scope — what the Chat and Analytics panels the audit flagged read:
 *   chat-messages.json  Supabase Storage, app-config bucket  (Chat)
 *   cart_adds           table                                (Added to cart / Not bought)
 *   product_likes       table                                (Most liked)
 *
 * Opt-in extras, each behind its own flag because they drive other panels:
 *   --page-views      page_views      (Top pages / Page activity / visitor counts)
 *   --carts           customer_carts + cart-events.json  (Abandoned carts)
 *   --addresses       addresses.json  (saved delivery addresses of deleted users)
 *
 * Products, product_images, collections and reviews are never touched.
 */

const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");

const BUCKET = "app-config";

async function blobCount(path: string): Promise<number | null> {
  const { data } = await supabaseAdmin.storage.from(BUCKET).download(path);
  if (!data) return null;
  try {
    const parsed = JSON.parse(Buffer.from(await data.arrayBuffer()).toString("utf-8"));
    return Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
  } catch {
    return null;
  }
}

async function emptyBlob(path: string): Promise<void> {
  await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, Buffer.from("[]", "utf-8"), { contentType: "application/json", upsert: true });
}

async function rows(table: string): Promise<number | null> {
  const { count, error } = await supabaseAdmin.from(table).select("*", { count: "exact", head: true });
  return error ? null : (count ?? 0);
}

const tables = ["cart_adds", "product_likes"];
if (args.has("--page-views")) tables.push("page_views");
if (args.has("--carts")) tables.push("customer_carts");

const blobs = ["chat-messages.json"];
if (args.has("--carts")) blobs.push("cart-events.json");
if (args.has("--addresses")) blobs.push("addresses.json");

console.log(dry ? "DRY RUN — nothing will be changed\n" : "CLEARING\n");
console.log("TABLE / FILE          BEFORE   AFTER");

for (const t of tables) {
  const before = await rows(t);
  if (!dry && before) await supabaseAdmin.from(t).delete().not("id", "is", null);
  const after = dry ? before : await rows(t);
  console.log(`${t.padEnd(22)} ${String(before).padStart(5)}   ${String(after).padStart(5)}`);
}

for (const b of blobs) {
  const before = await blobCount(b);
  if (!dry && before) await emptyBlob(b);
  const after = dry ? before : await blobCount(b);
  console.log(`${b.padEnd(22)} ${String(before).padStart(5)}   ${String(after).padStart(5)}`);
}

console.log("\nUntouched: products, product_images, collections, reviews, site-settings.json.");
for (const t of ["products", "product_images", "collections", "reviews"]) {
  console.log(`  ${t.padEnd(16)} ${await rows(t)} rows`);
}
