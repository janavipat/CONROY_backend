import { supabaseAdmin } from "../src/lib/supabase.js";

/**
 * A job killed mid-attempt must be re-queued as due immediately, so the pass
 * that reclaims it can also run it. Uses its own throwaway order.
 */
const MARK = "__jobtest__";
let orderId = "";
let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown, d = "") {
  if (actual === expected) { passed++; console.log(`  PASS  ${name} → ${String(actual)}`); }
  else { failed++; console.log(`  FAIL  ${name} → expected ${String(expected)}, got ${String(actual)} ${d}`); }
}

try {
  const { data: o } = await supabaseAdmin.from("orders").insert({
    email: `${MARK}@example.invalid`, full_name: MARK, phone: "+910000000031",
    shipping_address: MARK, subtotal: 999, currency: "INR",
    status: "cod_pending", fulfillment_status: "Pending",
  }).select("id").single();
  orderId = String((o as { id: string }).id);

  // A job abandoned 30 minutes ago, exactly like the two stuck in production.
  const stale = new Date(Date.now() - 30 * 60_000).toISOString();
  await supabaseAdmin.from("shipment_jobs").insert({
    order_id: orderId, kind: "create", state: "running", attempts: 0, locked_at: stale,
  });

  const { reclaimStaleJobsForTest } = await import("../src/services/shipping/jobs.js");
  await reclaimStaleJobsForTest();

  const { data: j } = await supabaseAdmin.from("shipment_jobs")
    .select("state, attempts, next_run_at, last_error").eq("order_id", orderId).single();
  const job = j as Record<string, string>;
  check("re-queued", job.state, "queued");
  check("attempt counted", job.attempts, 1);
  check("error recorded", Boolean(job.last_error), true);
  check("due immediately", new Date(job.next_run_at).getTime() <= Date.now() + 1000, true, job.next_run_at);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  if (orderId) await supabaseAdmin.from("orders").delete().eq("id", orderId);
  console.log("test order removed");
}
