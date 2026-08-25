import { supabaseAdmin } from "../src/lib/supabase.js";
import { env } from "../src/config/env.js";

/**
 * The courier side of deleting an order.
 *
 * Deleting is a soft delete now (see test-soft-delete.ts for the section, the
 * restore and the permanent removal); what this covers is the part that talks
 * to Delhivery — a live booking must be stopped before an order leaves the
 * lists, and a courier refusal must leave the order exactly as it was.
 *
 * Every order and shipment is created and removed here. Waybills are synthetic
 * and outside the issued range, so nothing real is ever cancelled.
 *
 * Requires supabase/soft-delete-orders.sql.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const ADMIN = { "x-admin-key": env.ADMIN_KEY ?? "" };
const MARK = "__deletetest__";

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
      phone: "+910000000071",
      shipping_address: MARK,
      subtotal: 999,
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

/**
 * @param booked mimics a shipment Delhivery acknowledged. A booked row with a
 *   waybill Delhivery cannot recognise is how the refusal path is reached.
 */
async function attachShipment(orderId: string, booked: boolean, status = "Success") {
  seq++;
  const { error } = await supabaseAdmin.from("shipments").insert({
    order_id: orderId,
    waybill: `1000${String(seq).padStart(9, "0")}`,
    ref_no: `${MARK}-${seq}`,
    provider: "delhivery",
    status,
    create_response: booked ? { success: true, packages: [{ status: "Success" }] } : null,
  });
  if (error) throw new Error(error.message);
}

const del = (id: string) => fetch(`${API}/admin/orders/${id}`, { method: "DELETE", headers: ADMIN });

async function deletedAt(id: string) {
  const { data } = await supabaseAdmin.from("orders").select("deleted_at").eq("id", id).maybeSingle();
  return (data as { deleted_at: string | null } | null)?.deleted_at ?? null;
}

async function shipmentCount(id: string) {
  const { count } = await supabaseAdmin
    .from("shipments")
    .select("*", { count: "exact", head: true })
    .eq("order_id", id);
  return count ?? 0;
}

try {
  console.log(`API: ${API}\n`);

  const probe = await supabaseAdmin.from("orders").select("deleted_at").limit(1);
  if (probe.error) {
    console.log("MIGRATION NOT APPLIED — run supabase/soft-delete-orders.sql first.");
    process.exitCode = 1;
    throw new Error("migration missing");
  }

  console.log("1. Order with no shipment → deletes cleanly");
  {
    const id = await makeOrder();
    const r = await del(id);
    check("delete accepted", r.status, 200, await r.clone().text());
    check("marked deleted", Boolean(await deletedAt(id)), true);
  }

  console.log("\n2. Order whose booking the courier releases → deletes, record kept");
  {
    const id = await makeOrder("Manifested");
    await attachShipment(id, false); // never acknowledged, so nothing to stop
    const r = await del(id);
    check("delete accepted", r.status, 200, await r.clone().text());
    check("marked deleted", Boolean(await deletedAt(id)), true);
    // The point of soft delete: the shipment record survives for the audit
    // trail instead of cascading away with the row.
    check("shipment record kept", await shipmentCount(id), 1);
  }

  console.log("\n3. Courier refuses → order left completely untouched");
  {
    const id = await makeOrder("Manifested");
    await attachShipment(id, true); // booked; Delhivery will not release it
    const r = await del(id);
    check("delete refused", r.status, 503, await r.clone().text());
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    check("says not deleted", body.error?.includes("has not been deleted") ?? false, true, String(body.error));
    check("not marked deleted", await deletedAt(id), null);
    check("shipment untouched", await shipmentCount(id), 1);
  }

  console.log("\n4. Shipment already cancelled → delete proceeds");
  {
    const id = await makeOrder("Manifested");
    await attachShipment(id, true, "Cancelled"); // skipped by the courier step
    const r = await del(id);
    check("delete accepted", r.status, 200, await r.clone().text());
    check("marked deleted", Boolean(await deletedAt(id)), true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  for (const id of orders) await supabaseAdmin.from("orders").delete().eq("id", id);
  const { count } = await supabaseAdmin
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("full_name", MARK);
  console.log(`\ncleanup: ${orders.length} test orders removed, ${count ?? 0} left`);
}
