import { supabaseAdmin } from "../src/lib/supabase.js";
import { env } from "../src/config/env.js";

/**
 * Deleted Orders: soft delete, restore, permanent delete.
 *
 * Every order is created and removed by this script; no existing order is read
 * or modified. The shipment rows it attaches carry synthetic waybills outside
 * the issued range, so nothing is ever sent to Delhivery on their behalf.
 *
 * Requires supabase/soft-delete-orders.sql.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const ADMIN = { "x-admin-key": env.ADMIN_KEY ?? "" };
const PHONE = "+910000000061";
const MARK = "__softdeletetest__";

const orders: string[] = [];
let passed = 0;
let failed = 0;
let seq = 0;

function check(name: string, actual: unknown, expected: unknown, detail = "") {
  if (actual === expected) {
    passed++;
    console.log(`  PASS  ${name} → ${String(actual)}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} → expected ${String(expected)}, got ${String(actual)}  ${detail}`);
  }
}

async function makeOrder(fulfillment = "Pending") {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      email: `${MARK}@example.invalid`,
      full_name: MARK,
      phone: PHONE,
      shipping_address: MARK,
      subtotal: 1500,
      currency: "INR",
      status: "cod_pending",
      fulfillment_status: fulfillment,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const id = String((data as { id: string }).id);
  orders.push(id);
  return id;
}

async function addItem(orderId: string) {
  await supabaseAdmin.from("order_items").insert({
    order_id: orderId,
    product_handle: `${MARK}-handle`,
    title: "Test item",
    size: "32",
    fit: "Straight",
    price: 1500,
    quantity: 1,
  });
}

/** Synthetic waybill: 13 digits starting 1000, never issued by Delhivery. */
async function addShipment(orderId: string) {
  seq++;
  await supabaseAdmin.from("shipments").insert({
    order_id: orderId,
    waybill: `1000${String(seq).padStart(9, "0")}`,
    ref_no: `${MARK}-${seq}`,
    provider: "delhivery",
    status: "Cancelled", // already stopped, so the courier step is a no-op
    create_response: null,
  });
}

const del = (id: string) => fetch(`${API}/admin/orders/${id}`, { method: "DELETE", headers: ADMIN });
const restore = (id: string) =>
  fetch(`${API}/admin/orders/${id}/restore`, { method: "POST", headers: ADMIN });
const purge = (id: string) =>
  fetch(`${API}/admin/orders/${id}/permanent`, { method: "DELETE", headers: ADMIN });

async function listIds(path: string) {
  const res = await fetch(`${API}${path}`, { headers: ADMIN });
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((o) => o.id);
}

async function rowExists(id: string) {
  const { data } = await supabaseAdmin.from("orders").select("id").eq("id", id).maybeSingle();
  return Boolean(data);
}

try {
  console.log(`API: ${API}\n`);

  const probe = await supabaseAdmin.from("orders").select("deleted_at").limit(1);
  if (probe.error) {
    console.log("MIGRATION NOT APPLIED — run supabase/soft-delete-orders.sql first.");
    console.log(`  (${probe.error.message})`);
    process.exitCode = 1;
    throw new Error("migration missing");
  }
  console.log("migration present: orders.deleted_at exists\n");

  console.log("1. Delete moves the order rather than destroying it");
  const id = await makeOrder("Manifested");
  await addItem(id);
  await addShipment(id);

  const res = await del(id);
  check("delete accepted", res.status, 200, await res.clone().text());
  check("row still present", await rowExists(id), true);

  const { data: row } = await supabaseAdmin
    .from("orders")
    .select("deleted_at, deleted_by, status, fulfillment_status, subtotal")
    .eq("id", id)
    .single();
  const r = row as Record<string, string | number | null>;
  check("marked deleted", Boolean(r.deleted_at), true);
  check("actor recorded", r.deleted_by, "admin");
  check("payment state kept", r.status, "cod_pending");
  check("fulfilment kept", r.fulfillment_status, "Manifested");
  check("total kept", r.subtotal, 1500);

  const { count: items } = await supabaseAdmin
    .from("order_items")
    .select("*", { count: "exact", head: true })
    .eq("order_id", id);
  check("items kept", items, 1);
  const { count: ships } = await supabaseAdmin
    .from("shipments")
    .select("*", { count: "exact", head: true })
    .eq("order_id", id);
  check("shipment record kept", ships, 1);

  console.log("\n2. It leaves the working lists and the customer's history");
  check("absent from admin orders", (await listIds("/admin/orders")).includes(id), false);
  check("present in deleted orders", (await listIds("/admin/orders/deleted")).includes(id), true);
  check(
    "absent from customer orders",
    (await listIds(`/orders?phone=${encodeURIComponent(PHONE)}`)).includes(id),
    false,
  );
  const cust = await fetch(`${API}/orders/${id}`);
  check("customer detail 404s", cust.status, 404);

  console.log("\n3. A deleted order is never shipped");
  {
    const { data: job } = await supabaseAdmin
      .from("shipment_jobs")
      .select("state")
      .eq("order_id", id)
      .eq("kind", "create")
      .maybeSingle();
    // Only asserted when a job existed to retire.
    if (job) check("create job retired", (job as { state: string }).state, "dead");

    // Queue one anyway and confirm the worker refuses it.
    await supabaseAdmin
      .from("shipment_jobs")
      .upsert({ order_id: id, kind: "create", state: "queued" }, { onConflict: "order_id,kind" });
    await fetch(`${API}/admin/shipments/drain`, { method: "POST", headers: ADMIN });
    const { data: after } = await supabaseAdmin
      .from("shipment_jobs")
      .select("state, last_error")
      .eq("order_id", id)
      .eq("kind", "create")
      .maybeSingle();
    const a = after as { state: string; last_error: string | null } | null;
    check("worker refused it", a?.state, "dead", String(a?.last_error));
    check("reason names the delete", a?.last_error?.includes("deleted") ?? false, true, String(a?.last_error));
  }

  console.log("\n4. Double delete is refused");
  check("second delete 409s", (await del(id)).status, 409);

  console.log("\n5. Restore puts it back");
  check("restore accepted", (await restore(id)).status, 200);
  check("back in admin orders", (await listIds("/admin/orders")).includes(id), true);
  check("gone from deleted orders", (await listIds("/admin/orders/deleted")).includes(id), false);
  check(
    "back in customer orders",
    (await listIds(`/orders?phone=${encodeURIComponent(PHONE)}`)).includes(id),
    true,
  );
  check("restoring twice 409s", (await restore(id)).status, 409);

  console.log("\n6. Permanent delete is only reachable from Deleted Orders");
  check("refused while live", (await purge(id)).status, 409);
  check("row still present", await rowExists(id), true);

  await del(id);
  check("purge accepted once deleted", (await purge(id)).status, 200);
  check("row gone", await rowExists(id), false);
  const { count: leftoverItems } = await supabaseAdmin
    .from("order_items")
    .select("*", { count: "exact", head: true })
    .eq("order_id", id);
  check("items cascaded", leftoverItems, 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  for (const o of orders) await supabaseAdmin.from("orders").delete().eq("id", o);
  const { count } = await supabaseAdmin
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("full_name", MARK);
  console.log(`\ncleanup: ${orders.length} test orders removed, ${count ?? 0} left`);
}
