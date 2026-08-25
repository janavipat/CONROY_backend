import { supabaseAdmin } from "../src/lib/supabase.js";
import { env } from "../src/config/env.js";

/**
 * Admin order deletion, end to end against the deployed API.
 *
 * Every order and shipment is created and removed by this script. No real
 * customer order is touched and no real waybill is ever sent to Delhivery —
 * the waybills here are synthetic and outside the issued range.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const PHONE = "+910000000021";
const MARK = "__deletetest__";
const ADMIN = { "x-admin-key": env.ADMIN_KEY ?? "" };

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

/** @param booked mimics a shipment Delhivery acknowledged (`success: true`). */
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

async function del(id: string) {
  const res = await fetch(`${API}/admin/orders/${id}`, { method: "DELETE", headers: ADMIN });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, error: String(body.error ?? ""), body };
}

async function exists(id: string) {
  const { data } = await supabaseAdmin.from("orders").select("id").eq("id", id).maybeSingle();
  return Boolean(data);
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

  console.log("1. Order without shipment → local delete works");
  {
    const id = await makeOrder();
    const r = await del(id);
    check("delete accepted", r.status, 200, r.error);
    check("row gone", await exists(id), false);
  }

  console.log("\n2. Order with a Delhivery shipment → shipment handled, then order deleted");
  {
    const id = await makeOrder("Manifested");
    await attachShipment(id, false); // courier releases it
    const r = await del(id);
    check("delete accepted", r.status, 200, r.error);
    check("order gone", await exists(id), false);
    check("shipment rows cascaded", await shipmentCount(id), 0);
  }

  console.log("\n3. Delhivery refuses → local order left untouched");
  {
    const id = await makeOrder("Manifested");
    await attachShipment(id, true); // booked; Delhivery will not release a fake waybill
    const r = await del(id);
    check("delete refused", r.status, 503, r.error);
    check("says not deleted", r.error.includes("has not been deleted"), true, r.error);
    check("order still present", await exists(id), true);
    check("shipment still present", await shipmentCount(id), 1);
  }

  console.log("\n4. Already-cancelled Delhivery shipment → delete succeeds");
  {
    const id = await makeOrder("Manifested");
    // A row already cancelled locally is skipped by the courier step entirely.
    await attachShipment(id, true, "Cancelled");
    const r = await del(id);
    check("delete accepted", r.status, 200, r.error);
    check("order gone", await exists(id), false);
  }

  console.log("\n5. Deleted order disappears from customer site and admin list");
  {
    const id = await makeOrder();
    await del(id);

    const mine = await fetch(`${API}/orders?phone=${encodeURIComponent(PHONE)}`);
    const list = (await mine.json()) as { data?: { id: string }[] };
    check("absent from customer orders", (list.data ?? []).some((o) => o.id === id), false);

    const cust = await fetch(`${API}/orders/${id}`);
    check("customer order detail 404s", cust.status, 404);

    const adminRes = await fetch(`${API}/admin/orders`, { headers: ADMIN });
    const admin = (await adminRes.json()) as { data?: { id: string }[] };
    check("absent from admin list", (admin.data ?? []).some((o) => o.id === id), false);
  }

  console.log("\n6. Double deletion is refused, not silently repeated");
  {
    const id = await makeOrder();
    check("first delete", (await del(id)).status, 200);
    const second = await del(id);
    check("second delete 404s", second.status, 404, second.error);
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
