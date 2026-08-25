import { supabaseAdmin } from "../src/lib/supabase.js";
import { env } from "../src/config/env.js";

/**
 * End-to-end order → Delhivery synchronisation.
 *
 * Places real orders through the public checkout endpoint and lets them
 * manifest for real, because that is the only way to prove the flow works.
 * Every order it creates is cancelled (which cancels the waybill at Delhivery)
 * and deleted in the finally block, so no booking is left standing. No existing
 * order is read, modified or cancelled.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const ADMIN = { "x-admin-key": env.ADMIN_KEY ?? "" };
const PHONE = "+910000000041";
const MARK = "__synctest__";

/*
 * Delhivery's fraud check refuses an obviously synthetic consignee
 * ("suspicious order/consignee"), so the leg that books a real waybill only
 * runs when real details are supplied. Without them the test still exercises
 * the whole machine — queue, retry, failure capture, idempotency — and just
 * cannot assert a waybill was issued.
 */
const SHIP = {
  name: process.env.TEST_SHIP_NAME ?? MARK,
  phone: process.env.TEST_SHIP_PHONE ?? "9999999999",
  line1: process.env.TEST_SHIP_LINE1 ?? "1 Test Street",
  city: process.env.TEST_SHIP_CITY ?? "Ahmedabad",
  state: process.env.TEST_SHIP_STATE ?? "Gujarat",
  pincode: process.env.TEST_SHIP_PINCODE ?? "380001",
};
const LIVE = Boolean(process.env.TEST_SHIP_PHONE);

const created: string[] = [];
let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown, detail = "") {
  if (actual === expected) {
    passed++;
    console.log(`  PASS  ${name} → ${String(actual)}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} → expected ${String(expected)}, got ${String(actual)}  ${detail}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real, shippable product — the courier call needs genuine catalogue data. */
async function pickProduct() {
  const { data } = await supabaseAdmin
    .from("products")
    .select("handle, sizes")
    .neq("is_shippable", false)
    .limit(1)
    .single();
  return data as { handle: string; sizes: unknown } | null;
}

async function placeOrder(paymentMethod: "cod" | "online", handle: string) {
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${MARK}@example.invalid`,
      fullName: MARK,
      phone: PHONE,
      paymentMethod,
      shippingAddress: "Test address, Ahmedabad, Gujarat 380001",
      shipAddress: { ...SHIP, country: "India" },
      items: [{ productHandle: handle, size: "32", quantity: 1 }],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const order = body.data as { id?: string } | undefined;
  if (!order?.id) throw new Error(`Order not created (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  created.push(order.id);
  return order.id;
}

async function drain() {
  const res = await fetch(`${API}/admin/shipments/drain`, { method: "POST", headers: ADMIN });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function adminRow(id: string) {
  const res = await fetch(`${API}/admin/orders`, { headers: ADMIN });
  const body = (await res.json()) as { data?: Record<string, unknown>[] };
  return (body.data ?? []).find((o) => o.id === id);
}

/** Drains until the order has a waybill, or gives up. */
async function waitForWaybill(id: string, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await drain();
    const row = await adminRow(id);
    if (row?.waybill) return row;
    await wait(4000);
  }
  return await adminRow(id);
}

async function shipmentRows(id: string) {
  const { data } = await supabaseAdmin.from("shipments").select("id, waybill, status").eq("order_id", id);
  return (data ?? []) as { id: string; waybill: string | null; status: string }[];
}

async function cancelAndDelete(id: string) {
  await fetch(`${API}/orders/${id}/cancel`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PHONE, reason: "Ordered by mistake" }),
  });
  await fetch(`${API}/admin/orders/${id}`, { method: "DELETE", headers: ADMIN });
}

try {
  console.log(`API: ${API}\n`);
  const product = await pickProduct();
  if (!product) throw new Error("No shippable product to test with.");
  console.log(`using product: ${product.handle}\n`);

  console.log("1. COD order placed on the website reaches Delhivery");
  const codId = await placeOrder("cod", product.handle);
  check("order created", Boolean(codId), true);
  check("visible in admin", Boolean(await adminRow(codId)), true);

  const codRow = await waitForWaybill(codId);
  check("job ran to a decision", codRow?.shipmentJobState !== null, true);
  check("shipment row exists", (await shipmentRows(codId)).length, 1);

  if (LIVE) {
    check("waybill issued", Boolean(codRow?.waybill), true, String(codRow?.shipmentError));
    check("admin reports synced", codRow?.shipmentSynced, true);
    check("job finished", codRow?.shipmentJobState, "done", String(codRow?.shipmentError));
    check("fulfilment advanced", codRow?.fulfillmentStatus, "Manifested");
    const stored = await shipmentRows(codId);
    check("waybill stored in db", stored[0]?.waybill === codRow?.waybill, true);
  } else {
    console.log("  SKIP  waybill assertions — set TEST_SHIP_PHONE etc. to book for real");
    check("failure was captured, not swallowed", Boolean(codRow?.shipmentError), true);
    check("admin flags it unsynced", codRow?.shipmentSynced, false);
  }

  console.log("\n2. Re-running creation does not book a second shipment");
  const again = await fetch(`${API}/admin/orders/${codId}/shipment`, { method: "POST", headers: ADMIN });
  const againBody = (await again.json()) as { data?: { waybill?: string } };
  if (LIVE) check("same waybill returned", againBody.data?.waybill, codRow?.waybill as string);
  await drain();
  await drain();
  check("still exactly one shipment row", (await shipmentRows(codId)).length, 1);

  console.log("\n3. Prepaid order follows the same flow");
  const paidId = await placeOrder("online", product.handle);
  const paidRow = await waitForWaybill(paidId);
  check("prepaid order recorded as paid", paidRow?.status, "paid");
  check("same queue used", paidRow?.shipmentJobState !== null, true);
  check("one shipment row", (await shipmentRows(paidId)).length, 1);
  if (LIVE) {
    check("waybill issued", Boolean(paidRow?.waybill), true, String(paidRow?.shipmentError));
    check("different waybill", paidRow?.waybill !== codRow?.waybill, true);
  }

  console.log("\n4. A cancelled order is never handed to the courier");
  const cancelId = await placeOrder("cod", product.handle);
  await fetch(`${API}/orders/${cancelId}/cancel`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PHONE, reason: "Ordered by mistake" }),
  });
  const { data: killed } = await supabaseAdmin
    .from("shipment_jobs")
    .select("state, last_error")
    .eq("order_id", cancelId)
    .eq("kind", "create")
    .maybeSingle();
  check("create job retired", (killed as { state?: string } | null)?.state, "dead");

  await drain();
  const afterDrain = await shipmentRows(cancelId);
  check("no waybill booked", afterDrain.every((s) => !s.waybill), true, JSON.stringify(afterDrain));

  console.log("\n5. An order the courier can never accept fails loudly, not silently");
  {
    // No ship_* fields, so createShipmentForOrder rejects it before any
    // courier call — the permanent-failure path.
    const { data } = await supabaseAdmin
      .from("orders")
      .insert({
        email: `${MARK}@example.invalid`,
        full_name: MARK,
        phone: PHONE,
        shipping_address: MARK,
        subtotal: 999,
        currency: "INR",
        status: "cod_pending",
        fulfillment_status: "Pending",
      })
      .select("id")
      .single();
    const badId = String((data as { id: string }).id);
    created.push(badId);
    await supabaseAdmin.from("shipment_jobs").insert({ order_id: badId, kind: "create" });

    await drain();
    const { data: j } = await supabaseAdmin
      .from("shipment_jobs")
      .select("state, last_error")
      .eq("order_id", badId)
      .eq("kind", "create")
      .maybeSingle();
    const job = j as { state?: string; last_error?: string } | null;
    check("marked dead, not retried forever", job?.state, "dead");
    check("reason recorded", Boolean(job?.last_error), true, String(job?.last_error));

    const row = await adminRow(badId);
    check("admin shows it unsynced", row?.shipmentSynced, false);
    check("admin surfaces the reason", Boolean(row?.shipmentError), true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  console.log("\ncleaning up (cancels each waybill at Delhivery, then deletes)…");
  for (const id of created) {
    try {
      await cancelAndDelete(id);
    } catch (err) {
      console.warn(`  cleanup failed for ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  const { count } = await supabaseAdmin
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("full_name", MARK);
  console.log(`cleanup: ${created.length} test orders handled, ${count ?? 0} left`);
}
