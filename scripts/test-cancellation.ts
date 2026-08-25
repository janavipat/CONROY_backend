import { supabaseAdmin } from "../src/lib/supabase.js";

/**
 * End-to-end cancellation tests against the deployed API.
 *
 * Every order and shipment used here is created by this script and deleted in
 * the finally block. No real customer order is read, updated or cancelled, and
 * no real waybill is ever sent to Delhivery — the waybills below are synthetic
 * and deliberately outside the issued range.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const PHONE = "+910000000009";
const MARK = "__canceltest__";

const orders: string[] = [];
const shipments: string[] = [];
let passed = 0;
let failed = 0;

function check(name: string, actual: number, expected: number, detail = "") {
  if (actual === expected) {
    passed++;
    console.log(`  PASS  ${name} → ${actual}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} → expected ${expected}, got ${actual}  ${detail}`);
  }
}

async function makeOrder(status: string, fulfillment: string) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      email: `${MARK}@example.invalid`,
      full_name: MARK,
      phone: PHONE,
      shipping_address: MARK,
      subtotal: 999,
      currency: "INR",
      status,
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
async function attachShipment(orderId: string, booked: boolean) {
  const { data, error } = await supabaseAdmin
    .from("shipments")
    .insert({
      order_id: orderId,
      // Synthetic: 13 digits starting 1000, never an issued Delhivery waybill.
      waybill: `1000${String(orders.length).padStart(9, "0")}`,
      ref_no: `${MARK}-${orders.length}`,
      provider: "delhivery",
      status: "Success",
      create_response: booked ? { success: true, packages: [{ status: "Success" }] } : null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  shipments.push(String((data as { id: string }).id));
}

async function cancel(id: string, phone = PHONE) {
  const res = await fetch(`${API}/orders/${id}/cancel`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, reason: "Ordered by mistake" }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, error: String(body.error ?? "") };
}

async function stateOf(id: string) {
  const { data } = await supabaseAdmin
    .from("orders")
    .select("status, fulfillment_status, refund_status, cancel_reason, cancelled_by, cancelled_at")
    .eq("id", id)
    .single();
  return (data ?? {}) as Record<string, string | null>;
}

try {
  console.log(`API: ${API}\n`);

  console.log("1. Cancellable states, no shipment attached");
  for (const s of ["Pending", "Confirmed", "Processing", "Packed", "Manifested"]) {
    const id = await makeOrder("cod_pending", s);
    const r = await cancel(id);
    check(s, r.status, 200, r.error);
  }

  console.log("\n2. Non-cancellable states are still refused");
  for (const s of ["Shipped", "Out For Delivery", "Delivered", "Returned"]) {
    const id = await makeOrder("cod_pending", s);
    const r = await cancel(id);
    check(s, r.status, 409, r.error);
  }

  console.log("\n3. Stale shipment row Delhivery never acknowledged → must not block");
  for (const s of ["Pending", "Manifested"]) {
    const id = await makeOrder("cod_pending", s);
    await attachShipment(id, false);
    const r = await cancel(id);
    check(`${s} + unbooked shipment`, r.status, 200, r.error);
  }

  console.log("\n4. Booked shipment Delhivery refuses → order left untouched, retryable");
  for (const s of ["Pending", "Manifested"]) {
    const id = await makeOrder("cod_pending", s);
    await attachShipment(id, true);
    const r = await cancel(id);
    check(`${s} + booked shipment`, r.status, 503, r.error);
    const after = await stateOf(id);
    check(
      `${s} unchanged after refusal`,
      after.fulfillment_status === s && after.status === "cod_pending" ? 1 : 0,
      1,
      JSON.stringify(after),
    );
  }

  console.log("\n5. Already-cancelled and wrong-owner");
  const dup = await makeOrder("cod_pending", "Pending");
  await cancel(dup);
  check("second cancel", (await cancel(dup)).status, 409);
  const other = await makeOrder("cod_pending", "Pending");
  check("wrong phone", (await cancel(other, "+919999999998")).status, 403);

  console.log("\n6. Recorded cancellation details");
  const cod = await makeOrder("cod_pending", "Pending");
  await cancel(cod);
  const codState = await stateOf(cod);
  check("COD → status cancelled", codState.status === "cancelled" ? 1 : 0, 1);
  check("COD → fulfilment Cancelled", codState.fulfillment_status === "Cancelled" ? 1 : 0, 1);
  check("COD → no refund", codState.refund_status === "None" ? 1 : 0, 1, String(codState.refund_status));
  check("COD → reason stored", codState.cancel_reason ? 1 : 0, 1);
  check("COD → actor is customer", codState.cancelled_by === "customer" ? 1 : 0, 1);
  check("COD → timestamp stored", codState.cancelled_at ? 1 : 0, 1);

  const prepaid = await makeOrder("paid", "Pending");
  await cancel(prepaid);
  const prepaidState = await stateOf(prepaid);
  check(
    "Prepaid → refund Initiated",
    prepaidState.refund_status === "Initiated" ? 1 : 0,
    1,
    String(prepaidState.refund_status),
  );

  console.log("\n7. Courier stop succeeds → DB cancelled → customer refetch shows Cancelled");
  {
    const id = await makeOrder("cod_pending", "Manifested");
    await attachShipment(id, false);

    const res = await fetch(`${API}/orders/${id}/cancel`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, reason: "Ordered by mistake" }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    check("cancel accepted", res.status, 200, String(body.error ?? ""));

    // The exact shape the frontend reads: { success, message, order }.
    check("response.success", body.success === true ? 1 : 0, 1);
    check("response.message present", body.message ? 1 : 0, 1);
    const returned = body.order as Record<string, string> | undefined;
    check("response.order present", returned ? 1 : 0, 1);
    check(
      "response.order is Cancelled",
      returned?.fulfillment_status === "Cancelled" ? 1 : 0,
      1,
      String(returned?.fulfillment_status),
    );

    // Database is the source of truth.
    const db = await stateOf(id);
    check("db status cancelled", db.status === "cancelled" ? 1 : 0, 1, String(db.status));
    check("db fulfilment Cancelled", db.fulfillment_status === "Cancelled" ? 1 : 0, 1);
    check("db reason saved", db.cancel_reason ? 1 : 0, 1);
    check("db cancelled_at saved", db.cancelled_at ? 1 : 0, 1);
    check("db cancelled_by customer", db.cancelled_by === "customer" ? 1 : 0, 1);

    // Shipment row is written after the order, never before.
    const { data: ship } = await supabaseAdmin
      .from("shipments")
      .select("status")
      .eq("order_id", id)
      .single();
    check(
      "shipment row Cancelled",
      (ship as { status?: string } | null)?.status === "Cancelled" ? 1 : 0,
      1,
      JSON.stringify(ship),
    );

    // What the customer page actually calls on refresh (MyOrders → load()).
    const listRes = await fetch(`${API}/orders?phone=${encodeURIComponent(PHONE)}`);
    const list = (await listRes.json()) as { data?: Record<string, string>[] };
    const refetched = (list.data ?? []).find((o) => o.id === id);
    check("refetch returns order", refetched ? 1 : 0, 1);
    check(
      "refetch shows Cancelled",
      refetched?.fulfillment_status === "Cancelled" ? 1 : 0,
      1,
      String(refetched?.fulfillment_status),
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  for (const id of shipments) await supabaseAdmin.from("shipments").delete().eq("id", id);
  for (const id of orders) await supabaseAdmin.from("orders").delete().eq("id", id);

  const { count } = await supabaseAdmin
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("full_name", MARK);
  console.log(`\ncleanup: ${orders.length} orders + ${shipments.length} shipments removed, ${count ?? 0} left`);
}
