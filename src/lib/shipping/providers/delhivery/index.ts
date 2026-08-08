import { delhiveryConfigured } from "./client.js";
import { createShipment, cancelShipment } from "./manifest.js";
import { trackShipment, checkServiceability } from "./tracking.js";
import { generateLabel } from "./labels.js";
import { normalizeStatus } from "./status-map.js";
import type { NormalizedShipmentEvent, ShippingProvider } from "../../provider.js";

export { delhiveryConfigured };

export const delhiveryProvider: ShippingProvider = {
  createShipment,
  cancelShipment,
  trackShipment,
  generateLabel,
  checkServiceability,
  normalizeStatus(raw: unknown): NormalizedShipmentEvent | null {
    const r = raw as { AWB?: string; waybill?: string };
    const waybill = r?.AWB ?? r?.waybill;
    if (!waybill) return null;
    return normalizeStatus(waybill, raw);
  },
};
