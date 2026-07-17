import type { Request, Response } from "express";
import { z } from "zod";
import { jsonStore } from "../lib/blobStore.js";
import { ApiError } from "../middleware/errors.js";

export interface Address {
  id: string;
  fullName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

// One JSON object: { [customerPhone]: Address[] }.
const store = jsonStore<Record<string, Address[]>>("addresses.json", {});

const addressSchema = z.object({
  id: z.string().min(1).max(60),
  fullName: z.string().max(120),
  phone: z.string().max(40),
  line1: z.string().max(200),
  line2: z.string().max(200).optional().default(""),
  city: z.string().max(100),
  state: z.string().max(100),
  pincode: z.string().max(12),
  isDefault: z.boolean().optional().default(false),
});

const saveSchema = z.object({
  phone: z.string().min(4).max(40),
  addresses: z.array(addressSchema).max(20),
});

/** GET /api/addresses?phone= — a customer's saved delivery addresses. */
export async function listAddresses(req: Request, res: Response) {
  const phone = String(req.query.phone ?? "").trim();
  if (!phone) throw new ApiError(400, "A phone query parameter is required.");
  const all = await store.read();
  res.json({ ok: true, data: all[phone] ?? [] });
}

/** PUT /api/addresses — replaces a customer's saved address list. */
export async function saveAddresses(req: Request, res: Response) {
  const { phone, addresses } = saveSchema.parse(req.body);
  // Exactly one default (the marked one, else the first).
  const withDefault = addresses.map((a, i) => ({
    ...a,
    isDefault: addresses.some((x) => x.isDefault) ? a.isDefault : i === 0,
  }));
  const all = await store.read();
  all[phone] = withDefault;
  await store.write(all);
  res.json({ ok: true, message: "Addresses saved.", data: withDefault });
}
