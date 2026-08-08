import { delhiveryGet } from "./client.js";
import type { LabelInput, LabelResult } from "../../provider.js";

interface DelhiveryPackingSlipPackage {
  wbn?: string;
  pdf_download_link?: string;
  pdf_link?: string;
}

interface DelhiveryPackingSlipResponse {
  packages_found?: number;
  packages?: DelhiveryPackingSlipPackage[] | null;
}

/** Verified live 2026-08-09 for the not-found case (`packages_found: 0`, `packages: null`). */
export async function generateLabel(input: LabelInput): Promise<LabelResult> {
  const res = await delhiveryGet<DelhiveryPackingSlipResponse>("/api/p/packing_slip/", {
    wbns: input.waybill,
    pdf: "true",
  });

  if (!res.ok) return { ok: false, raw: res.body ?? res.bodyText, error: res.error };

  const pkg = res.body?.packages?.[0];
  const labelUrl = pkg?.pdf_download_link || pkg?.pdf_link;
  if (!res.body?.packages_found || !labelUrl) {
    return { ok: false, raw: res.body, error: { message: "No label available for this waybill.", classification: "permanent" } };
  }

  return { ok: true, labelUrl, raw: res.body };
}
