import { supabaseAdmin } from "../src/lib/supabase.js";
import { env } from "../src/config/env.js";

/**
 * No shipment job may sit in 'queued' or 'running' with nothing to rescue it.
 *
 * Drives the real recovery path — the deployed worker — rather than calling the
 * reclaim helper in-process, because that helper is global and would sweep up
 * other orders' jobs too. As a guard against exactly that, the test refuses to
 * run if anything else is already queued or running.
 */

const API = process.env.TEST_API ?? "https://conroy-backend.vercel.app/api";
const ADMIN = { "x-admin-key": env.ADMIN_KEY ?? "" };
const MARK = "__recoverytest__";

const orders: string[] = [];
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

/** No ship_* fields, so the worker resolves it without any courier call. */
async function makeOrder() {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      email: `${MARK}@example.invalid`,
      full_name: MARK,
      phone: "+910000000051",
      shipping_address: MARK,
      subtotal: 999,
      currency: "INR",
      status: "cod_pending",
      fulfillment_status: "Pending",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const id = String((data as { id: string }).id);
  orders.push(id);
  return id;
}

async function jobOf(orderId: string) {
  const { data } = await supabaseAdmin
    .from("shipment_jobs")
    .select("state, attempts, next_run_at, last_error")
    .eq("order_id", orderId)
    .eq("kind", "create")
    .maybeSingle();
  return data as { state: string; attempts: number; next_run_at: string; last_error: string | null } | null;
}

const drain = () => fetch(`${API}/admin/shipments/drain`, { method: "POST", headers: ADMIN });

try {
  const { data: busy } = await supabaseAdmin
    .from("shipment_jobs")
    .select("order_id, state")
    .in("state", ["queued", "running"]);
  if ((busy ?? []).length) {
    console.log("REFUSING TO RUN — other jobs are queued/running, and draining would process them:");
    for (const b of busy ?? []) console.log(`  ${String((b as { order_id: string }).order_id).slice(0, 8)} ${(b as { state: string }).state}`);
    process.exitCode = 1;
    throw new Error("precondition failed");
  }
  console.log("precondition: no other jobs queued or running\n");

  console.log("1. A job abandoned mid-attempt is reclaimed and resolved");
  {
    const id = await makeOrder();
    // Exactly the shape a killed serverless attempt leaves behind.
    await supabaseAdmin.from("shipment_jobs").insert({
      order_id: id,
      kind: "create",
      state: "running",
      attempts: 0,
      locked_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    check("starts stuck in running", (await jobOf(id))?.state, "running");

    await drain(); // reclaims it and, because it is due immediately, runs it
    const after = await jobOf(id);
    check("no longer running", after?.state !== "running", true, JSON.stringify(after));
    check("attempt was counted", (after?.attempts ?? 0) >= 1, true);
    check("reason recorded", Boolean(after?.last_error), true);
  }

  console.log("\n2. A due queued job is picked up, not left sitting");
  {
    const id = await makeOrder();
    await supabaseAdmin.from("shipment_jobs").insert({
      order_id: id,
      kind: "create",
      state: "queued",
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await drain();
    const after = await jobOf(id);
    check("resolved, not still queued", after?.state, "dead", JSON.stringify(after));
    check("reason is specific", after?.last_error?.includes("address") ?? false, true, String(after?.last_error));
  }

  console.log("");
  console.log("3. The unattended path is the same worker");
  if (!env.CRON_SECRET) {
    // The cron entrypoint calls runDueShipmentJobs — the identical function the
    // drain above just exercised — so this only checks the authenticated route.
    console.log("  SKIP  cron entrypoint — CRON_SECRET not available locally");
  } else {
    const id = await makeOrder();
    await supabaseAdmin.from("shipment_jobs").insert({
      order_id: id,
      kind: "create",
      state: "running",
      attempts: 0,
      locked_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    const res = await fetch(`${API}/jobs/shipment/run`, {
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
    });
    check("cron entrypoint authorised", res.status, 200);
    const after = await jobOf(id);
    check("cron rescued it too", after?.state !== "running", true, JSON.stringify(after));
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
