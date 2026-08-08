import type { ShipAddress } from "../pricing.js";

export type { ShipAddress };

/** Item line for a shipment — just enough for a courier's manifest/description. */
export interface ShipmentItem {
  title: string;
  quantity: number;
}

export interface CreateShipmentInput {
  /** Used as the courier's client reference — the idempotency key (section 12). */
  orderId: string;
  shipTo: ShipAddress;
  paymentMode: "prepaid" | "cod";
  /** Required when paymentMode is "cod". */
  codAmount?: number;
  items: ShipmentItem[];
  /** Total order value — couriers use this for insurance/declared value. */
  declaredValue: number;
  /** Total shipment weight in grams, if every item has weight_g set. */
  weightG?: number;
  /** Largest single item's dimensions, if known (see AGENTS notes on packages). */
  dimensionsCm?: { length: number; width: number; height: number };
}

export interface ShippingError {
  message: string;
  classification: "transient" | "permanent";
  code?: string;
  httpStatus?: number;
}

export interface CreateShipmentResult {
  ok: boolean;
  refNo: string;
  waybill?: string;
  /** Raw provider status string, e.g. "Manifested". */
  status?: string;
  raw: unknown;
  error?: ShippingError;
}

export interface CancelShipmentInput {
  waybill: string;
}

export interface CancelShipmentResult {
  ok: boolean;
  raw: unknown;
  error?: ShippingError;
}

export interface TrackShipmentInput {
  waybill: string;
}

/** A single courier scan, normalized to this project's internal status model. */
export interface NormalizedShipmentEvent {
  waybill: string;
  /** Raw courier status string, e.g. "Dispatched", "In Transit". */
  status: string;
  statusType?: string;
  location?: string;
  remark?: string;
  /** The courier's own event time — not when we received the webhook/poll. */
  occurredAt: string;
  /** This project's fulfillment_status value this event maps to. */
  internalStatus: string;
  /** Monotonic rank — see status-map.ts. Never apply an event with a lower
   *  rank than the order's current one; events can arrive out of order. */
  rank: number;
  payload: unknown;
}

export interface TrackingResult {
  ok: boolean;
  events: NormalizedShipmentEvent[];
  raw: unknown;
  error?: ShippingError;
}

export interface LabelInput {
  waybill: string;
}

export interface LabelResult {
  ok: boolean;
  labelUrl?: string;
  raw?: unknown;
  error?: ShippingError;
}

export interface ServiceabilityResult {
  ok: boolean;
  serviceable: boolean;
  codAvailable: boolean;
  prepaidAvailable: boolean;
  raw: unknown;
  error?: ShippingError;
}

/**
 * A courier integration. Delhivery is the first implementation
 * (providers/delhivery/) — business logic (services/shipping/*) depends on
 * this interface, never on a provider's own request/response shapes.
 */
export interface ShippingProvider {
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  cancelShipment(input: CancelShipmentInput): Promise<CancelShipmentResult>;
  trackShipment(input: TrackShipmentInput): Promise<TrackingResult>;
  generateLabel(input: LabelInput): Promise<LabelResult>;
  checkServiceability(pincode: string): Promise<ServiceabilityResult>;
  /** Normalizes one raw webhook/poll event into this project's status model. */
  normalizeStatus(raw: unknown): NormalizedShipmentEvent | null;
}
