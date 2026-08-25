import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";

/**
 * A customer's saved delivery addresses.
 *
 * Scoped by phone, the same identity the rest of the customer API uses (order
 * history, cancellation). Every handler re-checks ownership against the row it
 * is about to touch, so an id belonging to someone else is a 404 rather than an
 * edit of their address.
 */

export interface Address {
  id: string;
  fullName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  label: string;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const LABELS = ["Home", "Work", "Other"] as const;

/** The delivery fields the courier needs; label and default are ours. */
const addressInput = z.object({
  fullName: z.string().trim().min(1, "Enter the recipient's name").max(120),
  phone: z.string().trim().min(6, "Enter a contact number").max(40),
  line1: z.string().trim().min(1, "Enter the flat, house or building").max(200),
  line2: z.string().trim().max(200).optional().default(""),
  city: z.string().trim().min(1, "Enter the city").max(100),
  state: z.string().trim().min(1, "Enter the state").max(100),
  pincode: z.string().trim().regex(/^[0-9]{4,10}$/, "Enter a valid pincode"),
  label: z.enum(LABELS).optional().default("Home"),
  isDefault: z.boolean().optional().default(false),
});

const createSchema = addressInput.extend({
  customerPhone: z.string().trim().min(4).max(40),
});

const updateSchema = addressInput.partial().extend({
  customerPhone: z.string().trim().min(4).max(40),
});

const ownerSchema = z.object({ customerPhone: z.string().trim().min(4).max(40) });

type Row = Record<string, unknown>;

function toAddress(r: Row): Address {
  return {
    id: r.id as string,
    fullName: (r.full_name as string) ?? "",
    phone: (r.phone as string) ?? "",
    line1: (r.line1 as string) ?? "",
    line2: (r.line2 as string) ?? "",
    city: (r.city as string) ?? "",
    state: (r.state as string) ?? "",
    pincode: (r.pincode as string) ?? "",
    label: (r.label as string) ?? "Home",
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/**
 * The address book is keyed to a customer row, so it must exist before an
 * address can reference it. Signup creates it; this covers a shopper whose
 * account predates that, rather than failing them with a foreign key error.
 */
async function ensureCustomer(phone: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("users")
    .upsert({ phone }, { onConflict: "phone", ignoreDuplicates: true });
  if (error) console.warn(`Customer row not ensured for ${phone}:`, error.message);
}

/** Reads one address, but only if it belongs to this customer. */
async function ownedAddress(id: string, customerPhone: string): Promise<Row> {
  const { data, error } = await supabaseAdmin
    .from("customer_addresses")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);

  // Deliberately the same 404 either way: a customer probing ids must not be
  // able to tell "someone else's address" from "no such address".
  if (!data || data.customer_phone !== customerPhone) {
    throw new ApiError(404, "Address not found.");
  }
  return data as Row;
}

/**
 * Makes one address the only default for a customer.
 *
 * Clearing first, then setting, because the database enforces at most one
 * default per customer — setting before clearing would collide with the
 * existing one.
 */
async function makeDefault(id: string, customerPhone: string): Promise<void> {
  await supabaseAdmin
    .from("customer_addresses")
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq("customer_phone", customerPhone)
    .neq("id", id);

  const { error } = await supabaseAdmin
    .from("customer_addresses")
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new ApiError(500, error.message);
}

/** Promotes the newest remaining address when a customer has no default. */
async function ensureSomeDefault(customerPhone: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("customer_addresses")
    .select("id, is_default")
    .eq("customer_phone", customerPhone)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as { id: string; is_default: boolean }[];
  if (!rows.length || rows.some((r) => r.is_default)) return;
  await makeDefault(rows[0].id, customerPhone);
}

/** GET /api/addresses?phone= — a customer's saved delivery addresses. */
export async function listAddresses(req: Request, res: Response) {
  const phone = String(req.query.phone ?? "").trim();
  if (!phone) throw new ApiError(400, "A phone query parameter is required.");

  const { data, error } = await supabaseAdmin
    .from("customer_addresses")
    .select("*")
    .eq("customer_phone", phone)
    // Default first: checkout wants it without having to sort client-side.
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);

  res.json({ ok: true, data: (data ?? []).map(toAddress) });
}

/** POST /api/addresses — adds one address to the book. */
export async function createAddress(req: Request, res: Response) {
  const input = createSchema.parse(req.body);
  await ensureCustomer(input.customerPhone);

  const { count } = await supabaseAdmin
    .from("customer_addresses")
    .select("*", { count: "exact", head: true })
    .eq("customer_phone", input.customerPhone);

  // The first address a customer saves is their default; there is nothing else
  // it could be, and leaving them with none would mean checkout had no address
  // to preselect.
  const isFirst = (count ?? 0) === 0;
  const wantsDefault = input.isDefault || isFirst;

  const { data, error } = await supabaseAdmin
    .from("customer_addresses")
    .insert({
      customer_phone: input.customerPhone,
      full_name: input.fullName,
      phone: input.phone,
      line1: input.line1,
      line2: input.line2 || null,
      city: input.city,
      state: input.state,
      pincode: input.pincode,
      label: input.label,
      is_default: false, // set below, so the one-default index is never violated
    })
    .select("*")
    .single();
  if (error) throw new ApiError(500, error.message);

  const row = data as Row;
  if (wantsDefault) await makeDefault(row.id as string, input.customerPhone);

  const { data: fresh } = await supabaseAdmin
    .from("customer_addresses")
    .select("*")
    .eq("id", row.id as string)
    .single();

  res.status(201).json({ ok: true, message: "Address saved.", data: toAddress((fresh ?? row) as Row) });
}

/** PATCH /api/addresses/:id — edits an address in place, never duplicating it. */
export async function updateAddress(req: Request, res: Response) {
  const { id } = req.params;
  const input = updateSchema.parse(req.body);
  await ownedAddress(id, input.customerPhone);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.fullName !== undefined) patch.full_name = input.fullName;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.line1 !== undefined) patch.line1 = input.line1;
  if (input.line2 !== undefined) patch.line2 = input.line2 || null;
  if (input.city !== undefined) patch.city = input.city;
  if (input.state !== undefined) patch.state = input.state;
  if (input.pincode !== undefined) patch.pincode = input.pincode;
  if (input.label !== undefined) patch.label = input.label;

  const { error } = await supabaseAdmin.from("customer_addresses").update(patch).eq("id", id);
  if (error) throw new ApiError(500, error.message);

  // Handled separately: it has to clear the previous default first.
  if (input.isDefault) await makeDefault(id, input.customerPhone);

  const { data: fresh } = await supabaseAdmin
    .from("customer_addresses")
    .select("*")
    .eq("id", id)
    .single();
  res.json({ ok: true, message: "Address updated.", data: toAddress(fresh as Row) });
}

/** POST /api/addresses/:id/default — makes this the customer's default. */
export async function setDefaultAddress(req: Request, res: Response) {
  const { id } = req.params;
  const { customerPhone } = ownerSchema.parse(req.body);
  await ownedAddress(id, customerPhone);
  await makeDefault(id, customerPhone);

  const { data } = await supabaseAdmin
    .from("customer_addresses")
    .select("*")
    .eq("customer_phone", customerPhone)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });
  res.json({ ok: true, message: "Default address updated.", data: (data ?? []).map(toAddress) });
}

/** DELETE /api/addresses/:id — removes an address from the book. */
export async function deleteAddress(req: Request, res: Response) {
  const { id } = req.params;
  const customerPhone = String(req.query.phone ?? req.body?.customerPhone ?? "").trim();
  if (!customerPhone) throw new ApiError(400, "A phone is required.");

  const row = await ownedAddress(id, customerPhone);

  const { error } = await supabaseAdmin.from("customer_addresses").delete().eq("id", id);
  if (error) throw new ApiError(500, error.message);

  // Removing the default must not leave the customer without one, or checkout
  // would fall back to a blank form despite addresses still being saved.
  if (row.is_default) await ensureSomeDefault(customerPhone);

  const { data } = await supabaseAdmin
    .from("customer_addresses")
    .select("*")
    .eq("customer_phone", customerPhone)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });
  res.json({ ok: true, message: "Address deleted.", data: (data ?? []).map(toAddress) });
}
