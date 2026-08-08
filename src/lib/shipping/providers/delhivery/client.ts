import { env } from "../../../../config/env.js";
import { classifyHttpError, classifyNetworkError } from "./errors.js";
import type { ShippingError } from "../../provider.js";

export const delhiveryConfigured = Boolean(
  env.DELHIVERY_API_URL &&
    env.DELHIVERY_API_TOKEN &&
    env.DELHIVERY_CLIENT_NAME &&
    env.DELHIVERY_PICKUP_LOCATION,
);

export interface DelhiveryResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  bodyText: string;
  error?: ShippingError;
}

const NOT_CONFIGURED: ShippingError = {
  message: "Delhivery is not configured (DELHIVERY_API_URL/API_TOKEN/CLIENT_NAME/PICKUP_LOCATION).",
  classification: "permanent",
};

/** GET requests (tracking, pincode serviceability) — auth header + query params, JSON response. */
export async function delhiveryGet<T = unknown>(
  path: string,
  searchParams: Record<string, string> = {},
): Promise<DelhiveryResponse<T>> {
  if (!delhiveryConfigured) return { ok: false, status: 0, body: null, bodyText: "", error: NOT_CONFIGURED };

  const url = new URL(path, env.DELHIVERY_API_URL);
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);

  return runRequest<T>(url, { method: "GET" });
}

/**
 * Form-encoded POST — used by the classic CMU API (create/cancel/edit).
 * Delhivery expects `format=json&data=<JSON string>` as
 * application/x-www-form-urlencoded, NOT a raw JSON body — verified against
 * the live account 2026-08-09 (an intentionally-empty shipments array came
 * back with a precise "shipment list contains no data" validation error,
 * confirming the payload was parsed correctly, not silently ignored).
 */
export async function delhiveryPostForm<T = unknown>(
  path: string,
  data: unknown,
): Promise<DelhiveryResponse<T>> {
  if (!delhiveryConfigured) return { ok: false, status: 0, body: null, bodyText: "", error: NOT_CONFIGURED };

  const url = new URL(path, env.DELHIVERY_API_URL);
  const form = new URLSearchParams();
  form.set("format", "json");
  form.set("data", JSON.stringify(data));

  return runRequest<T>(url, {
    method: "POST",
    body: form.toString(),
    contentType: "application/x-www-form-urlencoded",
  });
}

/**
 * Raw-JSON POST with `?format=json` — used by /api/p/edit (cancel). Without
 * the query param this same endpoint replies with XML instead; verified
 * against the live account 2026-08-09.
 */
export async function delhiveryPostJson<T = unknown>(
  path: string,
  data: unknown,
): Promise<DelhiveryResponse<T>> {
  if (!delhiveryConfigured) return { ok: false, status: 0, body: null, bodyText: "", error: NOT_CONFIGURED };

  const url = new URL(path, env.DELHIVERY_API_URL);
  url.searchParams.set("format", "json");

  return runRequest<T>(url, {
    method: "POST",
    body: JSON.stringify(data),
    contentType: "application/json",
  });
}

async function runRequest<T>(
  url: URL,
  init: { method: string; body?: string; contentType?: string },
): Promise<DelhiveryResponse<T>> {
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: init.method,
      headers: {
        Authorization: `Token ${env.DELHIVERY_API_TOKEN}`,
        Accept: "application/json",
        ...(init.contentType ? { "Content-Type": init.contentType } : {}),
      },
      body: init.body,
    });
  } catch (err) {
    return { ok: false, status: 0, body: null, bodyText: "", error: classifyNetworkError(err) };
  }

  const bodyText = await res.text();
  let body: T | null = null;
  try {
    body = bodyText ? (JSON.parse(bodyText) as T) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    return { ok: false, status: res.status, body, bodyText, error: classifyHttpError(res.status, bodyText) };
  }

  return { ok: true, status: res.status, body, bodyText };
}
