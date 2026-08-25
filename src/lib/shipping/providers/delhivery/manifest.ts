import { env } from "../../../../config/env.js";
import { delhiveryPostForm, delhiveryPostJson } from "./client.js";
import { trackShipment } from "./tracking.js";
import type {
  CancelShipmentInput,
  CancelShipmentResult,
  CreateShipmentInput,
  CreateShipmentResult,
} from "../../provider.js";

/**
 * Industry-standard volumetric divisor (cm³ / 5000 = kg). Delhivery computes
 * chargeable weight server-side regardless, but NOT verified against this
 * account's actual billing configuration (spec section 4) — confirm with
 * Delhivery before relying on this for cost estimates.
 */
const VOLUMETRIC_DIVISOR = 5000;

export function volumetricWeightG(dims: { length: number; width: number; height: number }): number {
  const volumetricKg = (dims.length * dims.width * dims.height) / VOLUMETRIC_DIVISOR;
  return Math.round(volumetricKg * 1000);
}

interface DelhiveryCreateResponsePackage {
  waybill?: string;
  status?: string;
  remarks?: string[] | string;
  serviceable?: boolean;
  client?: string;
  refnum?: string;
}

interface DelhiveryCreateResponse {
  success?: boolean;
  error?: boolean;
  rmk?: string;
  packages?: DelhiveryCreateResponsePackage[];
}

/**
 * Builds the classic CMU create payload and calls Delhivery. Field names
 * verified structurally (an empty `shipments: []` array was accepted and
 * precisely rejected as "contains no data" — confirming the request shape
 * parses correctly) but NOT yet verified with a real, fully-populated
 * shipment — no shipment has been created against this account yet.
 */
export async function createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
  const a = input.shipTo;
  const address = [a.line1, a.line2].filter(Boolean).join(", ");
  const isCod = input.paymentMode === "cod";

  const shipment: Record<string, unknown> = {
    name: a.name,
    add: address,
    pin: a.pincode,
    city: a.city,
    state: a.state,
    country: a.country || "India",
    phone: a.phone,
    order: input.orderId,
    payment_mode: isCod ? "COD" : "Prepaid",
    products_desc: input.items.map((i) => `${i.title} x${i.quantity}`).join(", ").slice(0, 500),
    total_amount: String(input.declaredValue),
    quantity: String(input.items.reduce((s, i) => s + i.quantity, 0)),
    shipping_mode: "Surface",
    address_type: "home",
  };
  if (isCod) shipment.cod_amount = String(input.codAmount ?? input.declaredValue);
  if (input.weightG) shipment.weight = String(input.weightG);
  if (input.dimensionsCm) {
    shipment.shipment_width = String(input.dimensionsCm.width);
    shipment.shipment_height = String(input.dimensionsCm.height);
  }

  const payload = {
    shipments: [shipment],
    pickup_location: { name: env.DELHIVERY_PICKUP_LOCATION },
  };

  const res = await delhiveryPostForm<DelhiveryCreateResponse>("/api/cmu/create.json", payload);

  if (!res.ok) {
    return { ok: false, refNo: input.orderId, raw: res.body ?? res.bodyText, error: res.error };
  }

  const pkg = res.body?.packages?.[0];
  if (!pkg || !pkg.waybill) {
    const remark = Array.isArray(pkg?.remarks) ? pkg.remarks.join("; ") : pkg?.remarks;
    return {
      ok: false,
      refNo: input.orderId,
      raw: res.body,
      error: {
        message: remark || res.body?.rmk || "Delhivery did not return a waybill.",
        classification: "permanent",
      },
    };
  }

  return { ok: true, refNo: input.orderId, waybill: pkg.waybill, status: pkg.status, raw: res.body };
}

interface DelhiveryEditResponse {
  /** Delhivery replies with the string "Success"/"Failure" here on some
   *  accounts and a boolean on others, so both shapes must be handled. */
  status?: string | boolean;
  error?: string;
}

/** True for every shape /api/p/edit uses to report a successful cancellation. */
export function editSucceeded(body: DelhiveryEditResponse | null): boolean {
  const status = body?.status;
  if (status === true) return true;
  return typeof status === "string" && status.trim().toLowerCase() === "success";
}

/**
 * Verified live 2026-08-09 for the not-found case (a dummy waybill correctly
 * came back `status: "Failure"` with a clear error, as JSON via `?format=json`
 * — without that query param this endpoint replies with XML instead).
 */
export async function cancelShipment(input: CancelShipmentInput): Promise<CancelShipmentResult> {
  const res = await delhiveryPostJson<DelhiveryEditResponse>("/api/p/edit", {
    waybill: input.waybill,
    cancellation: "true",
  });

  if (!res.ok) return { ok: false, raw: res.body ?? res.bodyText, error: res.error };

  if (editSucceeded(res.body)) return { ok: true, raw: res.body };

  /*
   * Delhivery has been observed cancelling the shipment and then replying in a
   * shape this endpoint didn't recognise as success, which left the parcel
   * cancelled at the courier while the order stayed active on the site.
   * Never report a failure without first asking Delhivery what the shipment's
   * actual state is.
   */
  const tracked = await trackShipment({ waybill: input.waybill });
  const cancelledAtCourier = tracked.ok && tracked.events.some((e) => e.status === "Cancelled");
  if (cancelledAtCourier) {
    return { ok: true, raw: { edit: res.body, tracking: tracked.raw } };
  }

  return {
    ok: false,
    raw: { edit: res.body, tracking: tracked.raw },
    error: {
      message: res.body?.error || "Delhivery did not confirm the cancellation.",
      classification: "permanent",
    },
  };
}
