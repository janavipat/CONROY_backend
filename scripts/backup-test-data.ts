import { writeFileSync } from "node:fs";
import { supabaseAdmin } from "../src/lib/supabase.js";

/**
 * Exports every table clear-test-data.ts touches, including the ones that
 * disappear via `on delete cascade` when an order goes — without them a
 * restore would bring back orders but not their items or shipments.
 *
 * Usage: npm run backup-test-data -- <path-to-write.json>
 *
 * The output holds customer names, phones, emails and addresses. Keep it out
 * of the repository and off anything public.
 */

const TABLES = [
  "orders",
  "order_items",
  "returns",
  "shipments",
  "shipment_jobs",
  "users",
  "contacts",
  // Tracking behind the Analytics panels.
  "cart_adds",
  "product_likes",
  "page_views",
  "customer_carts",
];

/** JSON stores in the app-config Storage bucket — Chat and carts live here. */
const BLOBS = ["chat-messages.json", "cart-events.json", "addresses.json"];

const path = process.argv[2];
if (!path) {
  console.error("Pass an output path, e.g. npm run backup-test-data -- ./backup.json");
  process.exit(1);
}

const dump: Record<string, unknown[]> = {};
for (const t of TABLES) {
  const { data, error } = await supabaseAdmin.from(t).select("*");
  if (error) {
    console.log(`${t.padEnd(16)} skipped (${error.message.slice(0, 40)})`);
    continue;
  }
  dump[t] = data ?? [];
  console.log(`${t.padEnd(16)} ${data?.length ?? 0} rows`);
}

const blobs: Record<string, unknown> = {};
for (const b of BLOBS) {
  const { data } = await supabaseAdmin.storage.from("app-config").download(b);
  if (!data) {
    console.log(`${b.padEnd(16)} absent`);
    continue;
  }
  const text = Buffer.from(await data.arrayBuffer()).toString("utf-8");
  blobs[b] = JSON.parse(text);
  console.log(`${b.padEnd(16)} ${Array.isArray(blobs[b]) ? (blobs[b] as unknown[]).length : 1} entries`);
}
dump.__blobs = [blobs];

writeFileSync(path, JSON.stringify(dump, null, 2), "utf8");
console.log("\nWritten to:", path);
console.log("Contains personal data — do not commit it.");
