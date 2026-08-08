import { supabaseAdmin } from "../../lib/supabase.js";
import { createShipmentForOrder } from "./createShipment.js";

/**
 * Backoff schedule per the architecture note: 2, 4, 8, 16, 32 minutes, then
 * hourly, dead at ~6 attempts. Index = attempts so far (0-based).
 */
const BACKOFF_MINUTES = [2, 4, 8, 16, 32, 60];
const MAX_ATTEMPTS = 6;

interface ShipmentJobRow {
  id: string;
  order_id: string;
  kind: string;
  state: string;
  attempts: number;
}

/**
 * Enqueues a "create" job for an order — best-effort, matching the pattern
 * used for every other post-migration column/table in this project. Called
 * right after an order is confirmed as paid/COD; never awaited by anything
 * that also needs to stay fast, since this itself is just a DB insert.
 */
export async function enqueueCreateShipmentJob(orderId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("shipment_jobs")
    .insert({ order_id: orderId, kind: "create" });
  if (error && error.code !== "23505") {
    // 23505 = a job for this order already exists (unique(order_id, kind)) — fine, not an error.
    console.warn("Shipment job not enqueued (run shipping.sql):", error.message);
  }
}

/**
 * Atomically transitions one job from queued → running. The conditional
 * UPDATE's WHERE clause is what makes this safe under concurrent callers —
 * Supabase's REST API has no way to express `FOR UPDATE SKIP LOCKED`
 * directly, but a `state = 'queued'` guard on the UPDATE is equivalent for
 * this purpose: at most one caller's UPDATE actually matches the row.
 */
async function claimJob(jobId: string): Promise<ShipmentJobRow | null> {
  const { data } = await supabaseAdmin
    .from("shipment_jobs")
    .update({ state: "running", locked_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("state", "queued")
    .select()
    .maybeSingle();
  return (data as ShipmentJobRow | null) ?? null;
}

async function completeJob(jobId: string): Promise<void> {
  await supabaseAdmin.from("shipment_jobs").update({ state: "done", locked_at: null }).eq("id", jobId);
}

async function failJob(job: ShipmentJobRow, message: string, permanent: boolean): Promise<void> {
  const attempts = job.attempts + 1;
  if (permanent || attempts >= MAX_ATTEMPTS) {
    await supabaseAdmin
      .from("shipment_jobs")
      .update({ state: "dead", attempts, last_error: message, locked_at: null })
      .eq("id", job.id);
    return;
  }
  const delayMin = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
  await supabaseAdmin
    .from("shipment_jobs")
    .update({
      state: "queued",
      attempts,
      last_error: message,
      next_run_at: new Date(Date.now() + delayMin * 60_000).toISOString(),
      locked_at: null,
    })
    .eq("id", job.id);
}

/** Claims and processes one job. Safe to call concurrently — see claimJob(). */
async function processJob(jobId: string): Promise<void> {
  const job = await claimJob(jobId);
  if (!job) return; // someone else claimed it, or it's no longer queued

  try {
    if (job.kind !== "create") return; // cancel/poll/reconcile: not built yet
    const outcome = await createShipmentForOrder(job.order_id);
    if (outcome.ok) {
      await completeJob(job.id);
    } else {
      await failJob(job, outcome.message, outcome.classification !== "transient");
    }
  } catch (err) {
    await failJob(job, err instanceof Error ? err.message : String(err), false);
  }
}

/**
 * Best-effort immediate attempt, fired right after enqueueing — NOT awaited
 * by the caller (checkout must never wait on Delhivery). On Vercel's Hobby
 * plan there's no frequent cron to fall back on, only a daily one, so this
 * is what makes shipments go out same-day in the common case rather than
 * within 24h. If the serverless function freezes before this finishes, the
 * job simply stays queued and the daily cron (runDueShipmentJobs) picks it
 * up — never lost, just slower.
 */
export function fireShipmentJobNow(orderId: string): void {
  void (async () => {
    try {
      const { data } = await supabaseAdmin
        .from("shipment_jobs")
        .select("id")
        .eq("order_id", orderId)
        .eq("kind", "create")
        .eq("state", "queued")
        .maybeSingle();
      if (data) await processJob(data.id as string);
    } catch (err) {
      console.warn("Immediate shipment job attempt failed (cron will retry):", err);
    }
  })();
}

/** Cron entrypoint — processes every job that's due, across all orders. */
export async function runDueShipmentJobs(limit = 25): Promise<{ processed: number }> {
  const { data: due } = await supabaseAdmin
    .from("shipment_jobs")
    .select("id")
    .eq("state", "queued")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(limit);

  let processed = 0;
  for (const row of due ?? []) {
    await processJob(row.id as string);
    processed++;
  }
  return { processed };
}
