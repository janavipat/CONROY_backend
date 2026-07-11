import crypto from "node:crypto";

/**
 * A tiny in-memory OTP store for the Twilio-direct flow (where we generate and
 * verify codes ourselves rather than delegating to Supabase). Good for a single
 * server instance / dev. For multi-instance production, back this with Redis or
 * a DB table keyed by phone.
 */
interface Entry {
  code: string;
  expires: number;
  attempts: number;
}

const store = new Map<string, Entry>();
const TTL_MS = 1 * 60 * 1000; // 1 minute
const MAX_ATTEMPTS = 5;

/** Cryptographically-random 6-digit code (100000–999999). */
export function generateOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export function saveOtp(phone: string, code: string): void {
  store.set(phone, { code, expires: Date.now() + TTL_MS, attempts: 0 });
}

/** Verifies a code, enforcing expiry + attempt limits. Consumes it on success. */
export function checkOtp(phone: string, code: string): { ok: boolean; reason?: string } {
  const entry = store.get(phone);
  if (!entry) {
    return { ok: false, reason: "No code was requested for this number, or it has expired." };
  }
  if (Date.now() > entry.expires) {
    store.delete(phone);
    return { ok: false, reason: "The code has expired. Please request a new one." };
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    store.delete(phone);
    return { ok: false, reason: "Too many incorrect attempts. Please request a new code." };
  }

  entry.attempts += 1;
  if (entry.code !== code) {
    return { ok: false, reason: "Invalid code." };
  }

  store.delete(phone); // one-time use
  return { ok: true };
}
