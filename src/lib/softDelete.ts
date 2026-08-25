import { supabaseAdmin } from "./supabase.js";

/**
 * Whether supabase/soft-delete-orders.sql has been applied.
 *
 * Every optional column in this project is treated as absent until proven
 * otherwise, so the store keeps working between a deploy and its migration.
 * Filtering on a column that does not exist is a hard PostgREST error, which
 * would take the orders list down rather than degrade — hence the probe.
 *
 * Cached after the first call: the answer only changes when a migration is
 * applied, and this sits in the path of every order query.
 */
let supported: boolean | null = null;

export async function softDeleteReady(): Promise<boolean> {
  if (supported !== null) return supported;

  const { error } = await supabaseAdmin.from("orders").select("deleted_at").limit(1);
  supported = !error;
  if (!supported) {
    console.warn(
      "orders.deleted_at is missing — deleted orders cannot be hidden or restored. " +
        "Run supabase/soft-delete-orders.sql.",
    );
  }
  return supported;
}

/** Test seam: forces the next call to re-probe. */
export function resetSoftDeleteProbe(): void {
  supported = null;
}
