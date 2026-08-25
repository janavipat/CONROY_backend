import { supabaseAdmin } from "../src/lib/supabase.js";
import { env } from "../src/config/env.js";

/**
 * What the admin surfaces report as an order's total.
 *
 * The amount shown must be what the customer actually owes — subtotal minus the
 * discount recorded on the order — and it must come from the order's own stored
 * figures, never from what the product costs today. Orders here are created and
 * removed by this script; no existing order or product is touched.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const ADMIN = { "x-admin-key": env.ADMIN_KEY ?? "" };
const PHONE = "+910000000091";
const MARK = "__pricingtest__";

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

async function makeOrder(opts: {
  subtotal: number;
  discount: number;
  status?: string;
  fulfillment?: string;
  /** Defaults to a handle that does not exist, proving no catalogue lookup. */
  productHandle?: string;
}) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      email: `${MARK}@example.invalid`,
      full_name: MARK,
      phone: PHONE,
      shipping_address: MARK,
      subtotal: opts.subtotal,
      discount: opts.discount,
      currency: "INR",
      status: opts.status ?? "cod_pending",
      fulfillment_status: opts.fulfillment ?? "Pending",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const id = String((data as { id: string }).id);
  created.push(id);

  await supabaseAdmin.from("order_items").insert({
    order_id: id,
    // Deliberately not a real product: the total must not depend on one.
    product_handle: opts.productHandle ?? `${MARK}-vanished-product`,
    title: "Test item",
    size: "32",
    fit: "Straight",
    price: opts.subtotal,
    quantity: 1,
  });
  return id;
}

async function adminRow(id: string, path = "/admin/orders") {
  const res = await fetch(`${API}${path}`, { headers: ADMIN });
  const body = (await res.json()) as { data?: Record<string, unknown>[] };
  return (body.data ?? []).find((o) => o.id === id);
}

try {
  console.log(`API: ${API}\n`);

  console.log("1. The reported case: ₹1,999 with a ₹600 discount");
  {
    const id = await makeOrder({ subtotal: 1999, discount: 600 });
    const row = await adminRow(id);
    check("subtotal", row?.subtotal, 1999);
    check("discount", row?.discount, 600);
    check("total is what the customer owes", row?.total, 1399);
  }

  console.log("\n2. No discount → total equals the subtotal");
  {
    const id = await makeOrder({ subtotal: 1999, discount: 0 });
    const row = await adminRow(id);
    check("total", row?.total, 1999);
    check("discount", row?.discount, 0);
  }

  console.log("\n3. Discounted COD");
  {
    const id = await makeOrder({ subtotal: 2499, discount: 500, status: "cod_pending" });
    const row = await adminRow(id);
    check("total", row?.total, 1999);
    check("payment method", row?.paymentMethod, "Cash on Delivery");
  }

  console.log("\n4. Discounted prepaid");
  {
    const id = await makeOrder({ subtotal: 2499, discount: 500, status: "paid" });
    const row = await adminRow(id);
    check("total", row?.total, 1999);
    check("payment method", row?.paymentMethod, "Online");
  }

  console.log("\n5. A percentage offer and a flat offer both land as rupees");
  {
    // computeDiscount resolves either offer type to an amount before the order
    // is written, so both reach the admin through the same stored field.
    const pct = await makeOrder({ subtotal: 2000, discount: 300 }); // 15% of 2000
    check("percentage-derived total", (await adminRow(pct))?.total, 1700);
    const flat = await makeOrder({ subtotal: 2000, discount: 250 });
    check("flat-derived total", (await adminRow(flat))?.total, 1750);
  }

  console.log("\n6. Cancelled order keeps its billed amount");
  {
    const id = await makeOrder({ subtotal: 1999, discount: 600, fulfillment: "Pending" });
    const res = await fetch(`${API}/orders/${id}/cancel`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE, reason: "Ordered by mistake" }),
    });
    check("cancel accepted", res.status, 200);
    const row = await adminRow(id);
    check("total unchanged", row?.total, 1399);
    check("status cancelled", row?.status, "cancelled");
  }

  console.log("\n7. Deleted order shows the same amount in Deleted orders");
  {
    const id = await makeOrder({ subtotal: 1999, discount: 600 });
    const res = await fetch(`${API}/admin/orders/${id}`, { method: "DELETE", headers: ADMIN });
    check("delete accepted", res.status, 200, await res.clone().text());
    const row = await adminRow(id, "/admin/orders/deleted");
    check("total in deleted orders", row?.total, 1399);
    check("subtotal retained", row?.subtotal, 1999);
    check("discount retained", row?.discount, 600);
  }

  console.log("\n8. Historical order: the product it referenced no longer exists");
  {
    // Every order above already references a handle with no product behind it.
    // If the total were recomputed from the catalogue it could not be right.
    const id = await makeOrder({ subtotal: 1999, discount: 600 });
    const { data: product } = await supabaseAdmin
      .from("products")
      .select("handle")
      .eq("handle", `${MARK}-vanished-product`)
      .maybeSingle();
    check("no such product exists", product, null);
    check("total still correct", (await adminRow(id))?.total, 1399);
  }

  console.log("\n9. Totals across the list are net, and cancelled orders are not sales");
  {
    const res = await fetch(`${API}/admin/orders`, { headers: ADMIN });
    const rows = ((await res.json()) as { data?: Record<string, number | string>[] }).data ?? [];
    const mismatched = rows.filter(
      (o) => (o.total as number) !== (o.subtotal as number) - (o.discount as number),
    );
    check("every row's total is subtotal − discount", mismatched.length, 0, JSON.stringify(mismatched.slice(0, 2)));

    const stats = (await (await fetch(`${API}/admin/stats`, { headers: ADMIN })).json()) as {
      data?: { revenue?: number };
    };
    const expected = rows
      .filter((o) => o.status !== "cancelled")
      .reduce((s, o) => s + ((o.subtotal as number) - (o.discount as number)), 0);
    check("dashboard revenue matches net, ex-cancelled", stats.data?.revenue, expected);
  }

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
