import { delhiveryGet } from "./client.js";
import { normalizeStatus } from "./status-map.js";
import type { ServiceabilityResult, TrackShipmentInput, TrackingResult } from "../../provider.js";

interface DelhiveryScanDetail {
  Scan?: string;
  ScanType?: string;
  ScanDateTime?: string;
  ScannedLocation?: string;
  Instructions?: string;
}

interface DelhiveryShipmentStatus {
  Status?: string;
  StatusType?: string;
  StatusDateTime?: string;
  StatusLocation?: string;
  Instructions?: string;
}

interface DelhiveryShipment {
  AWB?: string;
  Status?: DelhiveryShipmentStatus;
  Scans?: { ScanDetail: DelhiveryScanDetail }[];
}

interface DelhiveryTrackingResponse {
  Success?: boolean;
  Error?: string;
  ShipmentData?: { Shipment: DelhiveryShipment }[];
}

/**
 * NOT yet verified against a real shipment's full scan history — only the
 * "waybill doesn't exist" error path has been confirmed live (2026-08-09).
 * Re-check ShipmentData/Scans field names once a real shipment has scans.
 */
export async function trackShipment(input: TrackShipmentInput): Promise<TrackingResult> {
  const res = await delhiveryGet<DelhiveryTrackingResponse>("/api/v1/packages/json/", {
    waybill: input.waybill,
  });

  if (!res.ok) return { ok: false, events: [], raw: res.body ?? res.bodyText, error: res.error };

  if (res.body?.Success === false) {
    return {
      ok: false,
      events: [],
      raw: res.body,
      error: { message: res.body.Error || "Delhivery could not find this shipment.", classification: "permanent" },
    };
  }

  const shipment = res.body?.ShipmentData?.[0]?.Shipment;
  if (!shipment) {
    return { ok: false, events: [], raw: res.body, error: { message: "No shipment data returned.", classification: "transient" } };
  }

  const events = (shipment.Scans ?? [])
    .map((s) =>
      normalizeStatus(input.waybill, {
        Status: s.ScanDetail.Scan,
        StatusType: s.ScanDetail.ScanType,
        StatusDateTime: s.ScanDetail.ScanDateTime,
        StatusLocation: s.ScanDetail.ScannedLocation,
        Instructions: s.ScanDetail.Instructions,
      }),
    )
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // Always include the current status too, even if Scans is empty/unavailable.
  if (shipment.Status) {
    const current = normalizeStatus(input.waybill, shipment.Status);
    if (current && !events.some((e) => e.occurredAt === current.occurredAt && e.status === current.status)) {
      events.push(current);
    }
  }

  return { ok: true, events, raw: res.body };
}

interface DelhiveryPostalCode {
  cod?: "Y" | "N";
  pre_paid?: "Y" | "N";
  pickup?: "Y" | "N";
}

interface DelhiveryPincodeResponse {
  delivery_codes?: { postal_code: DelhiveryPostalCode }[];
}

/** Verified live 2026-08-09 against a real serviceable pincode (110001). */
export async function checkServiceability(pincode: string): Promise<ServiceabilityResult> {
  const res = await delhiveryGet<DelhiveryPincodeResponse>("/c/api/pin-codes/json/", {
    filter_codes: pincode,
  });

  if (!res.ok) {
    return { ok: false, serviceable: false, codAvailable: false, prepaidAvailable: false, raw: res.body ?? res.bodyText, error: res.error };
  }

  const postal = res.body?.delivery_codes?.[0]?.postal_code;
  if (!postal) {
    return { ok: true, serviceable: false, codAvailable: false, prepaidAvailable: false, raw: res.body };
  }

  return {
    ok: true,
    serviceable: true,
    codAvailable: postal.cod === "Y",
    prepaidAvailable: postal.pre_paid === "Y",
    raw: res.body,
  };
}
