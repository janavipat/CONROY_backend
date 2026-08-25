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
 * A job stuck in 'running' longer than this is assumed abandoned — the
 * serverless function that claimed it almost certainly got frozen or killed
 * mid-attempt (confirmed happening in practice 2026-08-09: an immediate-fire
 * attempt left a job at state='running' forever, since only 'queued' jobs
 * get reclaimed by anything). Comfortably above the 8s immediate-fire
 * timeout and any plausible single Delhivery call.
 */
const STALE_RUNNING_MINUTES = 10;

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

async function failJob(
  job: ShipmentJobRow,
  message: string,
  permanent: boolean,
  /** Skips the backoff — used when the previous attempt never actually ran. */
  retryNow = false,
): Promise<void> {
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
      next_run_at: retryNow
        ? new Date().toISOString()
        : new Date(Date.now() + delayMin * 60_000).toISOString(),
      locked_at: null,
    })
    .eq("id", job.id);
}

/**
 * Resets jobs abandoned mid-attempt so the pass that reclaims them can also
 * run them. Backoff exists to space out attempts that actually happened; a
 * killed attempt never reached Delhivery, so there is nothing to back off
 * from. Queueing these ~2 minutes out instead meant they were skipped by the
 * very pass that reclaimed them and had to wait for the next one — which on a
 * once-a-day cron is a whole day per attempt, so an order could sit unshipped
 * for ~48h. They are queued as due immediately instead.
 */
async function reclaimStaleJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MINUTES * 60_000).toISOString();
  const { data: stale } = await supabaseAdmin
    .from("shipment_jobs")
    .select("id, order_id, kind, state, attempts")
    .eq("state", "running")
    .lt("locked_at", cutoff);

  for (const row of stale ?? []) {
    await failJob(
      row as ShipmentJobRow,
      "Reclaimed: stuck in 'running' past the stale threshold (the process handling it was likely frozen/killed mid-attempt).",
      false,
      true,
    );
  }
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
 * Best-effort immediate attempt, fired right after enqueueing — the caller
 * does NOT await this (checkout must never wait on Delhivery: observed live
 * 2026-08-09 taking ~2 minutes end-to-end for one real order, so any bounded
 * timeout short enough to keep checkout responsive would just make it wait
 * for nothing). If the process gets frozen or killed mid-attempt, the job is
 * left in 'running' — reclaimStaleJobs() (run at the start of every cron
 * pass) is what actually guarantees it doesn't get stuck there forever, not
 * this function trying to finish in any particular amount of time.
 */
export async function fireShipmentJobNow(orderId: string): Promise<void> {
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
    console.warn("Immediate shipment job attempt failed (reclaim/cron will retry):", err);
  }
}

/** Cron entrypoint — processes every job that's due, across all orders. */
export async function runDueShipmentJobs(limit = 25): Promise<{ processed: number }> {
  await reclaimStaleJobs();

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

/** Test-only export: exercising reclaim without waiting for a cron pass. */
export const reclaimStaleJobsForTest = reclaimStaleJobs;
