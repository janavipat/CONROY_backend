import { supabaseAdmin } from "../src/lib/supabase.js";
import { env } from "../src/config/env.js";

/**
 * The exact reported scenario, end to end:
 *
 *   order placed on the site → Delhivery shipment created → admin sees the
 *   waybill → admin deletes → courier booking cancelled → order gone from All
 *   → present only in Deleted orders → still gone after a refresh.
 *
 * The order is created and removed by this script; no existing order is read or
 * modified. Booking is live, so it needs real consignee details — set
 * TEST_SHIP_PHONE and friends, or the courier leg is skipped and the rest of
 * the flow is still checked against a shipment row that was never booked.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const ADMIN = { "x-admin-key": env.ADMIN_KEY ?? "" };
const PHONE = "+910000000081";
const MARK = "__deletesynctest__";

const SHIP = {
  name: process.env.TEST_SHIP_NAME ?? MARK,
  phone: process.env.TEST_SHIP_PHONE ?? "9999999999",
  line1: process.env.TEST_SHIP_LINE1 ?? "1 Test Street",
  city: process.env.TEST_SHIP_CITY ?? "Ahmedabad",
  state: process.env.TEST_SHIP_STATE ?? "Gujarat",
  pincode: process.env.TEST_SHIP_PINCODE ?? "380009",
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

async function adminList(path: string) {
  const res = await fetch(`${API}${path}`, { headers: ADMIN });
  const body = (await res.json()) as { data?: Record<string, unknown>[] };
  return body.data ?? [];
}

async function shipmentOf(orderId: string) {
  const { data } = await supabaseAdmin
    .from("shipments")
    .select("id, waybill, status")
    .eq("order_id", orderId)
    .maybeSingle();
  return data as { id: string; waybill: string | null; status: string } | null;
}

try {
  console.log(`API: ${API}${LIVE ? "" : "  (courier leg skipped — no TEST_SHIP_PHONE)"}\n`);

  const probe = await supabaseAdmin.from("orders").select("deleted_at").limit(1);
  if (probe.error) {
    console.log("MIGRATION NOT APPLIED — run supabase/soft-delete-orders.sql first.");
    process.exitCode = 1;
    throw new Error("migration missing");
  }

  const { data: product } = await supabaseAdmin
    .from("products")
    .select("handle")
    .neq("is_shippable", false)
    .limit(1)
    .single();

  console.log("1. Order placed on the site is manifested");
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${MARK}@example.invalid`,
      fullName: MARK,
      phone: PHONE,
      paymentMethod: "cod",
      shippingAddress: "Test address, Ahmedabad, Gujarat 380009",
      shipAddress: { ...SHIP, country: "India" },
      items: [{ productHandle: (product as { handle: string }).handle, size: "32", quantity: 1 }],
    }),
  });
  const body = (await res.json()) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error(`Order not created: ${JSON.stringify(body).slice(0, 200)}`);
  created.push(id);
  check("order created", Boolean(id), true);

  // The shipment may still be settling if checkout's window expired.
  for (let i = 0; i < 5 && !(await shipmentOf(id))?.waybill; i++) {
    await fetch(`${API}/admin/shipments/drain`, { method: "POST", headers: ADMIN });
    await wait(3000);
  }

  const beforeDelete = await shipmentOf(id);
  if (LIVE) {
    check("waybill issued", Boolean(beforeDelete?.waybill), true, JSON.stringify(beforeDelete));
    const inAll = await adminList("/admin/orders");
    const row = inAll.find((o) => o.id === id);
    check("admin shows the waybill", row?.waybill, beforeDelete?.waybill ?? null);
  }

  console.log("\n2. Admin deletes it");
  const delRes = await fetch(`${API}/admin/orders/${id}`, { method: "DELETE", headers: ADMIN });
  check("delete accepted", delRes.status, 200, await delRes.clone().text());

  console.log("\n3. The courier booking is recorded as cancelled");
  const afterDelete = await shipmentOf(id);
  if (beforeDelete?.waybill) {
    check("shipment row cancelled", afterDelete?.status, "Cancelled", JSON.stringify(afterDelete));
    check("waybill retained for the record", afterDelete?.waybill, beforeDelete.waybill);
  } else {
    console.log("  SKIP  no waybill was issued, so there was nothing to cancel");
  }

  console.log("\n4. It is gone from every working tab");
  const all = await adminList("/admin/orders");
  check("absent from admin orders", all.some((o) => o.id === id), false);
  check(
    "absent from customer history",
    (await adminList(`/orders?phone=${encodeURIComponent(PHONE)}`)).some((o) => o.id === id),
    false,
  );

  console.log("\n5. It appears only in Deleted orders, with its details intact");
  const deleted = await adminList("/admin/orders/deleted");
  const row = deleted.find((o) => o.id === id);
  check("present in deleted orders", Boolean(row), true);
  check("waybill still shown", row?.waybill, beforeDelete?.waybill ?? null);
  check("total kept", row?.subtotal !== undefined, true);
  check("payment method kept", Boolean(row?.paymentMethod), true);
  check("items kept", Array.isArray(row?.items) && (row?.items as unknown[]).length > 0, true);

  console.log("\n6. Still absent after a refresh — repeatedly");
  for (let i = 1; i <= 4; i++) {
    const again = await adminList("/admin/orders");
    check(`refresh ${i}`, again.some((o) => o.id === id), false);
  }

  console.log("\n7. Deleting again is a no-op, not a second courier request");
  const secondStatus = (await fetch(`${API}/admin/orders/${id}`, { method: "DELETE", headers: ADMIN })).status;
  check("second delete refused", secondStatus, 409);
  const afterSecond = await shipmentOf(id);
  check("shipment unchanged", afterSecond?.status, afterDelete?.status ?? null);

  console.log("\n8. No shipment job can re-ship it");
  await supabaseAdmin
    .from("shipment_jobs")
    .upsert({ order_id: id, kind: "create", state: "queued" }, { onConflict: "order_id,kind" });
  await fetch(`${API}/admin/shipments/drain`, { method: "POST", headers: ADMIN });
  const { data: job } = await supabaseAdmin
    .from("shipment_jobs")
    .select("state, last_error")
    .eq("order_id", id)
    .eq("kind", "create")
    .maybeSingle();
  const j = job as { state: string; last_error: string | null } | null;
  check("job refused", j?.state, "dead", String(j?.last_error));
  check("reason names the delete", j?.last_error?.includes("deleted") ?? false, true, String(j?.last_error));
  const afterDrain = await shipmentOf(id);
  check("still no new waybill", afterDrain?.waybill ?? null, beforeDelete?.waybill ?? null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  for (const id of created) await supabaseAdmin.from("orders").delete().eq("id", id);
  const { count } = await supabaseAdmin
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("full_name", MARK);
  console.log(`\ncleanup: ${created.length} test orders removed, ${count ?? 0} left`);
}
