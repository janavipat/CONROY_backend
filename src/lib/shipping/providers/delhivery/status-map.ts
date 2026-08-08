import type { NormalizedShipmentEvent } from "../../provider.js";

/**
 * Delhivery event → this project's fulfillment_status, with a monotonic rank
 * (spec section 16). Never apply an event with a lower rank than the order's
 * current one — Delhivery's webhook/tracking events can arrive out of order.
 *
 * `statusType` (Delhivery's short code, e.g. "DL", "UD", "RT") is the primary
 * signal — it's stable. The free-text `status` string is a fallback for
 * anything the code table doesn't cover. NOT yet verified against a real
 * shipment's actual lifecycle (no shipment has been created yet) — re-check
 * this table against real tracking events from the first live test shipment.
 */
const STATUS_TYPE_MAP: Record<string, { internalStatus: string; rank: number }> = {
  MANIFESTED: { internalStatus: "Manifested", rank: 1 },
  PP: { internalStatus: "Manifested", rank: 1 }, // pickup pending
  PU: { internalStatus: "Shipped", rank: 2 }, // picked up / in transit
  IT: { internalStatus: "Shipped", rank: 2 }, // in transit
  OFD: { internalStatus: "Out For Delivery", rank: 3 },
  DL: { internalStatus: "Delivered", rank: 4 },
  UD: { internalStatus: "Attempt Failed", rank: 3 }, // undelivered / NDR
  RT: { internalStatus: "Returning", rank: 3 }, // RTO in transit
  DTO: { internalStatus: "Returned", rank: 4 }, // delivered to origin (RTO complete)
  CN: { internalStatus: "Cancelled", rank: 4 },
  LOST: { internalStatus: "Cancelled", rank: 4 },
};

/** Fallback keyword matching for when `statusType` is missing or unrecognized. */
const STATUS_TEXT_RULES: { match: RegExp; internalStatus: string; rank: number }[] = [
  { match: /manifest/i, internalStatus: "Manifested", rank: 1 },
  { match: /picked ?up|dispatched|in ?transit/i, internalStatus: "Shipped", rank: 2 },
  { match: /out for delivery/i, internalStatus: "Out For Delivery", rank: 3 },
  { match: /^delivered$/i, internalStatus: "Delivered", rank: 4 },
  { match: /rto.*delivered|delivered to origin/i, internalStatus: "Returned", rank: 4 },
  { match: /rto|return to origin/i, internalStatus: "Returning", rank: 3 },
  { match: /undelivered|ndr|delivery ?failed/i, internalStatus: "Attempt Failed", rank: 3 },
  { match: /cancel/i, internalStatus: "Cancelled", rank: 4 },
  { match: /lost/i, internalStatus: "Cancelled", rank: 4 },
];

interface RawDelhiveryScan {
  Status?: string;
  StatusType?: string;
  StatusDateTime?: string;
  StatusLocation?: string;
  Instructions?: string;
  [key: string]: unknown;
}

/** Normalizes one raw Delhivery scan (from tracking poll or webhook) to this project's model. */
export function normalizeStatus(waybill: string, raw: unknown): NormalizedShipmentEvent | null {
  const scan = raw as RawDelhiveryScan;
  const status = scan?.Status;
  if (!status) return null;

  const byCode = scan.StatusType ? STATUS_TYPE_MAP[scan.StatusType.toUpperCase()] : undefined;
  const byText = byCode ? undefined : STATUS_TEXT_RULES.find((r) => r.match.test(status));
  const resolved = byCode ?? byText;

  return {
    waybill,
    status,
    statusType: scan.StatusType,
    location: scan.StatusLocation,
    remark: scan.Instructions,
    occurredAt: scan.StatusDateTime ?? new Date().toISOString(),
    // Unrecognized events still get recorded (shipment_events keeps everything
    // for debugging) but don't move fulfillment_status — rank 0 means the
    // monotonic-progression check in applyScan.ts will always skip them.
    internalStatus: resolved?.internalStatus ?? "Shipped",
    rank: resolved?.rank ?? 0,
    payload: raw,
  };
}
