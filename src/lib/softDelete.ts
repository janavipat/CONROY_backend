import { supabaseAdmin } from "./supabase.js";

/**
 * Whether supabase/soft-delete-orders.sql has been applied.
 *
 * Every optional column in this project is treated as absent until proven
 * otherwise, so the store keeps working between a deploy and its migration.
 * Filtering on a column that does not exist is a hard PostgREST error, which
 * would take the orders list down rather than degrade — hence the probe.
 *
 * A positive result is cached for the life of the instance; a negative one is
 * re-checked, because the migration can land while the instance is running.
 */
let supported: boolean | null = null;
let lastWarnedAt = 0;
const PROBE_INTERVAL_MS = 60_000;

export async function softDeleteReady(): Promise<boolean> {
  /*
   * Only a positive answer is cached for good. A column cannot disappear, but
   * it can appear — and caching "no" forever meant an instance that started
   * before the migration kept serving unfiltered lists until it happened to
   * recycle. Deleted orders stayed visible in All while the same delete had
   * plainly worked, because a different instance answered that request.
   */
  if (supported === true) return true;

  const { error } = await supabaseAdmin.from("orders").select("deleted_at").limit(1);
  if (!error) {
    supported = true;
    return true;
  }

  // Re-probed at most this often while absent, so a fresh migration is picked
  // up quickly without adding a query to every order read forever.
  const now = Date.now();
  if (now - lastWarnedAt > PROBE_INTERVAL_MS) {
    lastWarnedAt = now;
    console.warn(
      "orders.deleted_at is missing — deleted orders cannot be hidden or restored. " +
        "Run supabase/soft-delete-orders.sql.",
    );
  }
  return false;
}

/** Test seam: forces the next call to re-probe. */
export function resetSoftDeleteProbe(): void {
  supported = null;
  lastWarnedAt = 0;
}
