import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { contactSchema, newsletterSchema } from "../validators/schemas.js";

/** POST /api/contact */
export async function submitContact(req: Request, res: Response) {
  const input = contactSchema.parse(req.body);

  const { error } = await supabaseAdmin.from("contacts").insert({
    name: input.name,
    email: input.email,
    phone: input.phone || null,
    subject: input.subject,
    message: input.message,
  });
  if (error) throw new ApiError(500, error.message);

  res.status(201).json({
    ok: true,
    message: "Thank you — your enquiry has been received. We'll be in touch shortly.",
  });
}

/** GET /api/admin/contacts — list contact-form enquiries (newest first). */
export async function listContacts(_req: Request, res: Response) {
  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new ApiError(500, error.message);
  res.json({ ok: true, data: data ?? [] });
}

/** PATCH /api/admin/contacts/:id — mark an enquiry handled / reopened. */
export async function setContactHandled(req: Request, res: Response) {
  const handled = Boolean(req.body?.handled);
  const { error } = await supabaseAdmin
    .from("contacts")
    .update({ handled })
    .eq("id", req.params.id);
  if (error) {
    // The `handled` column ships in the latest migration; guide the operator.
    console.warn("contacts.handled update failed:", error.message);
    throw new ApiError(500, "Run the latest DB migration to enable this (adds contacts.handled).");
  }
  res.json({ ok: true, message: handled ? "Marked as handled." : "Reopened." });
}

/** DELETE /api/admin/contacts/:id — remove an enquiry. */
export async function deleteContact(req: Request, res: Response) {
  const { error } = await supabaseAdmin.from("contacts").delete().eq("id", req.params.id);
  if (error) throw new ApiError(500, error.message);
  res.json({ ok: true, message: "Enquiry deleted." });
}

/** POST /api/newsletter */
export async function subscribeNewsletter(req: Request, res: Response) {
  const { email } = newsletterSchema.parse(req.body);

  // Upsert so re-subscribing is not an error.
  const { error } = await supabaseAdmin
    .from("newsletter_subscribers")
    .upsert({ email }, { onConflict: "email", ignoreDuplicates: true });
  if (error) throw new ApiError(500, error.message);

  res.status(201).json({ ok: true, message: "You're on the list. Welcome to CONROY." });
}
