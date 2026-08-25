import { supabaseAdmin } from "../src/lib/supabase.js";
import { env } from "../src/config/env.js";

/**
 * Email is optional at checkout.
 *
 * Delivery needs a phone and an address; the courier never sees an email. What
 * matters is that a blank one never blocks an order, a typo is still caught,
 * and nothing invents an address to fill the gap.
 *
 * Orders are created and removed by this script. Shipment creation is left to
 * fail on the missing address fields rather than booking anything real — the
 * point here is the order, not the courier.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const ADMIN = { "x-admin-key": env.ADMIN_KEY ?? "" };
const PHONE = "+910000000101";
const MARK = "__emailtest__";

const created: string[] = [];
let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown, detail = "") {
  if (actual === expected) {
    passed++;
    console.log(`  PASS  ${name} → ${JSON.stringify(actual)}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} → expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}  ${detail}`);
  }
}

async function pickProduct() {
  const { data } = await supabaseAdmin
    .from("products")
    .select("handle, sizes")
    .neq("is_shippable", false)
    .limit(1)
    .single();
  return data as { handle: string; sizes: string[] };
}

/** Posts a checkout exactly as the payment page does. */
async function placeOrder(email: string | undefined, paymentMethod: "cod" | "online", handle: string, size: string) {
  const payload: Record<string, unknown> = {
    fullName: MARK,
    phone: PHONE,
    paymentMethod,
    shippingAddress: "1 Test Street, Ahmedabad, Gujarat 380009",
    items: [{ productHandle: handle, size, quantity: 1 }],
  };
  // undefined means the field is omitted entirely, as a form with no value would.
  if (email !== undefined) payload.email = email;

  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const id = (body.data as { id?: string } | undefined)?.id;
  if (id) created.push(id);
  return { status: res.status, id, body };
}

async function storedEmail(id: string) {
  const { data } = await supabaseAdmin.from("orders").select("email").eq("id", id).maybeSingle();
  return (data as { email: string } | null)?.email;
}

try {
  console.log(`API: ${API}\n`);
  const product = await pickProduct();
  const size = product.sizes?.[0] ?? "32";
  console.log(`using ${product.handle} / size ${size}\n`);

  console.log("A. Email omitted entirely → order succeeds");
  {
    const r = await placeOrder(undefined, "cod", product.handle, size);
    check("order created", r.status, 201, JSON.stringify(r.body).slice(0, 200));
    check("stored email is blank", await storedEmail(r.id!), "");
  }

  console.log("\nA2. Email present but empty → order succeeds");
  {
    const r = await placeOrder("", "cod", product.handle, size);
    check("order created", r.status, 201, JSON.stringify(r.body).slice(0, 200));
    check("stored email is blank", await storedEmail(r.id!), "");
  }

  console.log("\nB. Valid email → stored exactly as given");
  {
    const r = await placeOrder(`${MARK}@example.invalid`, "cod", product.handle, size);
    check("order created", r.status, 201);
    check("stored verbatim", await storedEmail(r.id!), `${MARK}@example.invalid`);
  }

  console.log("\nC. Invalid email → rejected with a validation error");
  {
    const r = await placeOrder("not-an-email", "cod", product.handle, size);
    check("rejected", r.status, 400, JSON.stringify(r.body).slice(0, 200));
    check("order not created", r.id, undefined);
  }

  console.log("\nD. COD without email");
  {
    const r = await placeOrder(undefined, "cod", product.handle, size);
    check("order created", r.status, 201);
    const { data } = await supabaseAdmin.from("orders").select("status").eq("id", r.id!).maybeSingle();
    check("recorded as COD", (data as { status: string } | null)?.status, "cod_pending");
  }

  console.log("\nE. Prepaid without email");
  {
    const r = await placeOrder(undefined, "online", product.handle, size);
    check("order created", r.status, 201);
    const { data } = await supabaseAdmin.from("orders").select("status").eq("id", r.id!).maybeSingle();
    check("recorded as paid", (data as { status: string } | null)?.status, "paid");
  }

  console.log("\nF. An order with no email appears correctly in the admin panel");
  {
    const r = await placeOrder(undefined, "cod", product.handle, size);
    const res = await fetch(`${API}/admin/orders`, { headers: ADMIN });
    const rows = ((await res.json()) as { data?: Record<string, unknown>[] }).data ?? [];
    const row = rows.find((o) => o.id === r.id);
    check("listed", Boolean(row), true);
    check("email blank, not invented", row?.email, "");
    check("name still shown", row?.customerName, MARK);
    check("phone still shown", row?.phone, PHONE);
    check("total present", typeof row?.total, "number");
  }

  console.log("\nG. The courier never depended on email");
  {
    const r = await placeOrder(undefined, "cod", product.handle, size);
    // The shipment carries the delivery contact, which is unaffected.
    const { data } = await supabaseAdmin
      .from("orders")
      .select("phone, full_name, shipping_address, email")
      .eq("id", r.id!)
      .maybeSingle();
    const o = data as Record<string, string>;
    check("phone kept", o.phone, PHONE);
    check("name kept", o.full_name, MARK);
    check("address kept", Boolean(o.shipping_address), true);
    check("email blank", o.email, "");

    // createShipmentForOrder rejects on the missing ship_* fields, never on email.
    await fetch(`${API}/admin/shipments/drain`, { method: "POST", headers: ADMIN });
    const { data: job } = await supabaseAdmin
      .from("shipment_jobs")
      .select("last_error")
      .eq("order_id", r.id!)
      .eq("kind", "create")
      .maybeSingle();
    const err = (job as { last_error: string | null } | null)?.last_error ?? "";
    check("courier failure is about the address, not email", err.toLowerCase().includes("email"), false, err);
  }

  console.log("\nH. Other delivery fields are still required");
  {
    const res = await fetch(`${API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    check("empty order rejected", res.status, 400);
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
