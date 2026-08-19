/**
 * Staging-only behaviour — and the guardrails that keep it away from production.
 *
 * This module exists on the `staging` branch. Everything it *does* is gated on
 * `APP_ENV`, so a build of this branch behaves exactly like production until the
 * deployment's environment says otherwise. What it *forbids* is not gated: the
 * production database blocklist below is enforced unconditionally, because a
 * build of this branch is never the production deployment and a single mistyped
 * env var must not be enough to let test orders reach real customer data.
 *
 * Every value here is read lazily, on first use. `env.ts` imports this module,
 * and an ES import is evaluated before the importing module's body runs — so
 * anything computed at module load here would be reading `process.env` before
 * `dotenv.config()` had populated it, and a local `.env.local` would be ignored.
 */

/**
 * Supabase project refs this build must never talk to. The ref is the subdomain
 * of the project URL (https://<ref>.supabase.co) — public information that
 * already ships in the frontend bundle, not a credential.
 *
 * Overridable via PRODUCTION_SUPABASE_REFS (comma-separated) so another
 * production project can be fenced off without a code change.
 */
const DEFAULT_PRODUCTION_REFS = ["jviqryberbjmvpuqcuob"];

/** "staging" only when the environment says so — never inferred from the branch. */
export function appEnv(): string {
  return (process.env.APP_ENV ?? "production").trim().toLowerCase();
}

export function isStaging(): boolean {
  return appEnv() === "staging";
}

/**
 * Flat per-unit price, in whole rupees, that replaces every catalogue price in
 * staging — so the client can walk the real Razorpay checkout for ₹1 instead of
 * ₹1,799. Unset (or non-positive) leaves prices exactly as the database has
 * them, and it is ignored outright unless APP_ENV=staging, so production could
 * not be repriced even if the variable leaked into its environment.
 */
export function stagingPriceOverride(): number | null {
  if (!isStaging()) return null;
  const raw = Number(process.env.STAGING_PRICE_OVERRIDE_INR ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

/**
 * The staging price, when one is configured, else the catalogue price unchanged.
 *
 * Applied at every point a price leaves the backend — both product mappers and
 * the cart resolver — so the figure on the grid, the figure Razorpay charges and
 * the figure written to the order are always the same number.
 */
export function priceFor(catalogPrice: unknown): unknown {
  return stagingPriceOverride() ?? catalogPrice;
}

/**
 * The struck-through "was" price. Suppressed under a staging override: an MRP of
 * ₹1,799 left next to a price of ₹1 renders a "99% Off" badge on every tile,
 * which tells the client nothing about the real storefront.
 */
export function compareAtPriceFor(catalogCompareAt: unknown): unknown {
  return stagingPriceOverride() === null ? catalogCompareAt : undefined;
}

/**
 * Fail-closed check that this build is not pointed at a production database.
 *
 * Throws rather than warns: a staging API that quietly writes test orders, test
 * customers and test shipments into the live project is the worst outcome this
 * environment can produce, and a loud boot failure is cheap by comparison.
 */
export function assertNotProductionDatabase(supabaseUrl: string): void {
  const configured = (process.env.PRODUCTION_SUPABASE_REFS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const blocked = configured.length > 0 ? configured : DEFAULT_PRODUCTION_REFS;

  const hit = blocked.find((ref) => supabaseUrl.includes(ref));
  if (!hit) return;

  throw new Error(
    `Refusing to start: this is the staging build, but SUPABASE_URL points at the ` +
      `production project "${hit}". Point SUPABASE_URL, SUPABASE_ANON_KEY and ` +
      `SUPABASE_SERVICE_ROLE_KEY at the staging Supabase project instead.`,
  );
}

/**
 * True when this staging deployment has been explicitly cleared to take real
 * money. Off unless someone sets it, so the safe state is the default one.
 */
export function allowsLivePayments(): boolean {
  return (process.env.STAGING_ALLOW_LIVE_PAYMENTS ?? "").trim().toLowerCase() === "true";
}

/**
 * Refuses live payment keys in staging — unless the deployment has opted in.
 *
 * The default stays "no": a staging order is normally a sandbox transaction,
 * and an rzp_live_ key slipped in by accident would charge a real card for a
 * ₹1 order that only exists in the test database. Opting in takes a second,
 * deliberate variable (STAGING_ALLOW_LIVE_PAYMENTS=true) rather than deleting
 * the check, so the choice is visible in the environment and can be reversed
 * by unsetting one value.
 *
 * With it on, every payment here is REAL: real charge, real settlement, and a
 * refund to issue by hand, recorded against the staging database rather than
 * the production books.
 */
export function assertNotLivePaymentKeys(razorpayKeyId: string): void {
  if (!isStaging()) return;
  if (!razorpayKeyId.startsWith("rzp_live_")) return;
  if (allowsLivePayments()) {
    console.warn(
      "\n⚠️  STAGING IS TAKING REAL PAYMENTS — RAZORPAY_KEY_ID is a live key and\n" +
        "   STAGING_ALLOW_LIVE_PAYMENTS=true. Every checkout here charges a real\n" +
        "   card or UPI account. Orders are written to the STAGING database, so they\n" +
        "   will not appear in the production admin — reconcile and refund by hand.\n",
    );
    return;
  }
  throw new Error(
    "Refusing to start: APP_ENV=staging but RAZORPAY_KEY_ID is a live key. " +
      "Use the rzp_test_… pair from Razorpay → Settings → API Keys → Test Mode, or set " +
      "STAGING_ALLOW_LIVE_PAYMENTS=true to take real money from this deployment on purpose.",
  );
}

