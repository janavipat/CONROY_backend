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
