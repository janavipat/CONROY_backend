import { readFileSync } from "node:fs";
import { supabaseAdmin } from "../src/lib/supabase.js";

/**
 * Clears the store's test transaction data.
 *
 * Every order in this database was placed during development: 24 orders came
 * from 7 phone numbers, one of which placed 8 orders inside two hours, and
 * several reused a single phone under three or four different names. One order
 * carried an @conroy.global address — the store's own domain.
 *
 * Deleting an order cascades to order_items, returns, shipments and
 * shipment_jobs (all declared `on delete cascade`), so nothing is orphaned.
 * The catalogue — products, product_images, collections, reviews, offers — is
 * never touched, so the storefront is unaffected.
 *
 * Run with --restore <backup.json> to put everything back.
 */

// Supabase requires a filter on delete; each table gets one on a NOT NULL key.
const TARGETS: { table: string; key: string }[] = [
  { table: "orders", key: "id" }, // cascades to items/returns/shipments
  { table: "users", key: "phone" },
  { table: "contacts", key: "id" },
];

/** Read-only tables reported before and after, to prove the cascade behaved. */
const WATCH = [
  "orders",
  "order_items",
  "returns",
  "shipments",
  "shipment_jobs",
  "users",
  "contacts",
  "products",
  "product_images",
  "collections",
  "reviews",
];

async function counts(): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const t of WATCH) {
    const { count, error } = await supabaseAdmin
      .from(t)
      .select("*", { count: "exact", head: true });
    out[t] = error ? null : (count ?? 0);
  }
  return out;
}

const restoreArg = process.argv.indexOf("--restore");

if (restoreArg !== -1) {
  const dump = JSON.parse(readFileSync(process.argv[restoreArg + 1], "utf8")) as Record<
    string,
    unknown[]
  >;
  // Parents before children, so every FK has a row to point at by the time
  // the child is written.
  for (const table of [
    "users",
    "contacts",
    "orders",
    "order_items",
    "returns",
    "shipments",
    "shipment_jobs",
  ]) {
    const rows = dump[table] ?? [];
    if (!rows.length) continue;
    const { error } = await supabaseAdmin.from(table).upsert(rows);
    console.log(
      `${table.padEnd(16)} ${error ? "ERROR " + error.message : rows.length + " rows restored"}`,
    );
  }
  console.log("\nRestore complete.");
} else {
  const before = await counts();

  // Step one is always to say what is about to go, and to stop if that does
  // not match the 24 orders the audit classified as test checkouts.
  const EXPECTED_ORDERS = 24;
  console.log("PLANNED DELETION");
  console.log(`  orders          ${before.orders}  (expected ${EXPECTED_ORDERS})`);
  console.log(`  order_items     ${before.order_items}  via cascade`);
  console.log(`  returns         ${before.returns}  via cascade`);
  console.log(`  shipments       ${before.shipments}  via cascade`);
  console.log(`  shipment_jobs   ${before.shipment_jobs}  via cascade`);
  console.log(`  users           ${before.users}`);
  console.log(`  contacts        ${before.contacts}`);

  if (before.orders !== EXPECTED_ORDERS) {
    console.error(
      `\nABORTED — found ${before.orders} orders, expected ${EXPECTED_ORDERS}. The data changed ` +
        `since the audit, so re-classify before deleting anything.`,
    );
    process.exit(1);
  }
  console.log("\nCount matches the audit. Deleting…\n");

  for (const { table, key } of TARGETS) {
    const { error } = await supabaseAdmin.from(table).delete().not(key, "is", null);
    if (error) console.log(`${table}: ERROR ${error.message}`);
  }

  const after = await counts();

  console.log("TABLE              BEFORE   AFTER");
  for (const t of WATCH) {
    const b = before[t];
    const a = after[t];
    const label = b === null ? "(no table)" : `${String(b).padStart(6)}  ${String(a).padStart(6)}`;
    const flag = b !== null && b > 0 && a === 0 ? "  cleared" : "";
    console.log(`${t.padEnd(18)} ${label}${flag}`);
  }
  console.log("\nCatalogue rows above must be unchanged — the storefront reads those.");
}
