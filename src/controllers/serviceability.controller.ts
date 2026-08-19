import type { Request, Response } from "express";
import { ApiError } from "../middleware/errors.js";
import { delhiveryProvider, delhiveryConfigured } from "../lib/shipping/providers/delhivery/index.js";

/**
 * GET /api/shipping/serviceability?pincode=380013
 *
 * Whether the courier will deliver to a pincode, asked before the order exists
 * rather than after it is paid for.
 *
 * Without this the first time anyone learns a pincode is undeliverable is in a
 * background job, minutes later, with the customer's money already taken and
 * the order sitting at "Pending" forever — which is exactly what happened to
 * order 2E31ECAC (Delhivery: "311210 is non serviceable pincode").
 *
 * Deliberately open (no admin key): the checkout that needs it is public. It
 * returns only a yes/no and the city Delhivery has on file — the same thing any
 * courier's public pincode checker exposes, and nothing about this account.
 *
 * Fails OPEN. If the courier is unconfigured or its API is down, this reports
 * `serviceable: true` with `checked: false`. A checkout that blocks every sale
 * because a third party is unreachable is a worse failure than a rare shipment
 * that has to be sorted out by hand.
 */
export async function getServiceability(req: Request, res: Response) {
  const pincode = String(req.query.pincode ?? "").trim();

  if (!/^[0-9]{6}$/.test(pincode)) {
    throw new ApiError(400, "Enter a valid 6-digit pincode.");
  }

  if (!delhiveryConfigured) {
    return res.json({ ok: true, checked: false, pincode, serviceable: true });
  }

  const result = await delhiveryProvider.checkServiceability(pincode);

  // `ok:false` is the courier being unreachable, not a verdict on the pincode.
  if (!result.ok) {
    return res.json({ ok: true, checked: false, pincode, serviceable: true });
  }

  const raw = result.raw as
    | { delivery_codes?: { postal_code?: { city?: string; state_code?: string } }[] }
    | null;
  const postal = raw?.delivery_codes?.[0]?.postal_code;

  res.json({
    ok: true,
    checked: true,
    pincode,
    serviceable: result.serviceable,
    codAvailable: result.codAvailable,
    prepaidAvailable: result.prepaidAvailable,
    city: postal?.city,
    state: postal?.state_code,
  });
}
