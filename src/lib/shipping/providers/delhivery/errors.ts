import type { ShippingError } from "../../provider.js";

/**
 * Classifies a Delhivery API failure per the retry table (spec section 13).
 * Transient → the job worker retries with backoff. Permanent → the job goes
 * dead and needs a human (Needs Attention queue, Phase 7).
 */
export function classifyHttpError(httpStatus: number, bodyText: string): ShippingError {
  const body = bodyText.toLowerCase();

  if (httpStatus === 401 || httpStatus === 403) {
    return { message: "Delhivery rejected the request — check the API token.", classification: "permanent", httpStatus };
  }
  if (httpStatus === 429) {
    return { message: "Rate limited by Delhivery.", classification: "transient", httpStatus };
  }
  if (httpStatus >= 500) {
    return { message: `Delhivery server error (HTTP ${httpStatus}).`, classification: "transient", httpStatus };
  }

  // Known permanent-failure phrases Delhivery's classic API returns inside a
  // 200/400 body rather than as a distinct HTTP status.
  if (body.includes("not serviceable") || (body.includes("pin code") && body.includes("not"))) {
    return { message: "Pincode is not serviceable by Delhivery.", classification: "permanent", code: "NOT_SERVICEABLE", httpStatus };
  }
  if (body.includes("phone") && (body.includes("invalid") || body.includes("required"))) {
    return { message: "Invalid or missing phone number.", classification: "permanent", code: "INVALID_PHONE", httpStatus };
  }
  if (body.includes("pincode") && body.includes("invalid")) {
    return { message: "Invalid pincode.", classification: "permanent", code: "INVALID_PINCODE", httpStatus };
  }

  if (httpStatus >= 400 && httpStatus < 500) {
    return { message: `Delhivery rejected the shipment payload (HTTP ${httpStatus}).`, classification: "permanent", httpStatus };
  }

  return { message: `Unexpected Delhivery response (HTTP ${httpStatus}).`, classification: "transient", httpStatus };
}

/** Classifies a failure that never got an HTTP response at all (network layer). */
export function classifyNetworkError(err: unknown): ShippingError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("econnreset") || lower.includes("network") || lower.includes("fetch failed")) {
    return { message: `Network error calling Delhivery: ${message}`, classification: "transient" };
  }
  return { message: `Unexpected error calling Delhivery: ${message}`, classification: "transient" };
}
