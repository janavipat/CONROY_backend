import type { Request, Response } from "express";
import { supabaseAnon } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { sendWelcomeEmail } from "../lib/email.js";
import { twilioConfigured, sendSms } from "../lib/twilio.js";
import { whatsappConfigured, sendWhatsappOtp } from "../lib/whatsapp.js";
import { generateOtp, saveOtp, checkOtp } from "../lib/otpStore.js";
import { authSchema, phoneStartSchema, phoneVerifySchema, updateNameSchema } from "../validators/schemas.js";

/** Builds a lightweight session for a verified phone number. */
function phoneSession(e164: string, name?: string | null) {
  return {
    user: { id: e164, phone: e164, name: name || null },
    session: { access_token: crypto.randomUUID(), token_type: "bearer" },
  };
}

/**
 * The customer's stored display name, if we have one. Read back from `users`
 * rather than trusting the request body, so it works for sign-in as well as
 * sign-up. Best-effort: a missing column must never block authentication.
 */
async function storedName(e164: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("users")
      .select("full_name")
      .eq("phone", e164)
      .maybeSingle();
    return ((data?.full_name as string) || "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Looks up whether an account already exists for this phone number.
 * `error: true` means the lookup itself failed (e.g. table missing) — callers
 * should fail open in that case so a transient DB issue never locks people out.
 */
async function accountExists(e164: string): Promise<{ exists: boolean; error: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("phone")
    .eq("phone", e164)
    .maybeSingle();
  if (error) {
    console.warn("User lookup failed:", error.message);
    return { exists: false, error: true };
  }
  return { exists: Boolean(data), error: false };
}

/**
 * Persists the account after a verified OTP.
 *  - signup: creates the row (name required). Rejects if the number already
 *    has an account (one signup per number).
 *  - signin: the row must already exist; refuses otherwise. Keeps email current.
 * Sends the welcome email once, on brand-new signups.
 */
async function finalizeAuth(
  e164: string,
  opts: { mode: "signin" | "signup"; email?: string; fullName?: string },
): Promise<void> {
  const email = opts.email || null;

  if (opts.mode === "signup") {
    const { error } = await supabaseAdmin
      .from("users")
      .insert({ phone: e164, email, full_name: opts.fullName || null });

    if (error) {
      // 23505 = unique violation → this number already signed up.
      if (error.code === "23505") {
        throw new ApiError(409, "This number is already registered. Please sign in instead.");
      }
      // Any other error (e.g. full_name column missing) — retry without name so
      // a not-yet-migrated DB still lets people register.
      const retry = await supabaseAdmin.from("users").insert({ phone: e164, email });
      if (retry.error && retry.error.code === "23505") {
        throw new ApiError(409, "This number is already registered. Please sign in instead.");
      }
    }

    if (opts.email) {
      void sendWelcomeEmail(opts.email).catch((err) =>
        console.error("Welcome email failed:", err instanceof Error ? err.message : err),
      );
    }
    return;
  }

  // signin — keep email fresh; existence is enforced by the caller.
  if (email) {
    await supabaseAdmin.from("users").update({ email }).eq("phone", e164);
  }
}

/** Normalises a phone number to E.164, applying the default country code. */
function toE164(raw: string): string {
  const trimmed = raw.replace(/[\s-]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  // Bare 10-digit local number → prepend the default country code.
  return `${env.OTP_DEFAULT_COUNTRY_CODE}${trimmed.replace(/^0+/, "")}`;
}

/** POST /api/auth/register — creates a Supabase Auth user. */
export async function register(req: Request, res: Response) {
  const { email, password, firstName } = authSchema.parse(req.body);

  const { data, error } = await supabaseAnon.auth.signUp({
    email,
    password,
    options: { data: { first_name: firstName ?? null } },
  });
  if (error) throw new ApiError(400, error.message);

  res.status(201).json({
    ok: true,
    message: "Account created. Please check your email to confirm if confirmation is enabled.",
    data: { user: data.user, session: data.session },
  });
}

/** POST /api/auth/login — exchanges credentials for a Supabase session. */
export async function login(req: Request, res: Response) {
  const { email, password } = authSchema.parse(req.body);

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) throw new ApiError(401, error.message);

  res.json({
    ok: true,
    message: "Signed in.",
    data: { user: data.user, session: data.session },
  });
}

/** GET /api/auth/me — returns the user for a Bearer access token. */
export async function me(req: Request, res: Response) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw new ApiError(401, "Missing bearer token");

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error) throw new ApiError(401, error.message);

  res.json({ ok: true, data: data.user });
}

/* ───────────────────────── Phone OTP login ──────────────────────────────── */

/** POST /api/auth/phone/start — sends an OTP to the phone (SMS). */
export async function startPhoneOtp(req: Request, res: Response) {
  const { phone, mode } = phoneStartSchema.parse(req.body);
  const e164 = toE164(phone);

  // Gate before spending an OTP: signup needs a new number, signin an existing
  // one. Fail open only if the lookup itself errors (never lock users out).
  const { exists, error: lookupError } = await accountExists(e164);
  if (!lookupError) {
    if (mode === "signup" && exists) {
      throw new ApiError(409, "This number is already registered. Please sign in instead.");
    }
    if (mode === "signin" && !exists) {
      throw new ApiError(404, "No account found for this number. Please create an account first.");
    }
  }

  if (env.otpMock) {
    // Dev mode: no SMS is sent; any number is accepted with OTP_TEST_CODE.
    return res.json({
      ok: true,
      mock: true,
      phone: e164,
      code: env.OTP_TEST_CODE,
      message: `Mock mode — enter ${env.OTP_TEST_CODE} to sign in (no SMS sent).`,
    });
  }

  // WhatsApp Cloud API: send the OTP from your WhatsApp Business number (no SMS,
  // so no India DLT). We generate + verify the code ourselves.
  if (whatsappConfigured) {
    const code = generateOtp();
    // Send first — only store the code once WhatsApp has accepted the message.
    await sendWhatsappOtp(e164, code);
    saveOtp(e164, code);
    return res.json({
      ok: true,
      mock: false,
      phone: e164,
      channel: "whatsapp",
      message: "A verification code has been sent on WhatsApp.",
    });
  }

  // Twilio-direct: we generate the OTP and send it via Twilio ourselves, using
  // the sender (TWILIO_FROM / Messaging Service) configured in .env.
  if (twilioConfigured) {
    const code = generateOtp();
    // Send first — only store the code once Twilio has accepted the SMS, so a
    // failed send never leaves a code the user can't receive.
    await sendSms(e164, `${code} is your CONROY verification code. It expires in 1 minute.`);
    saveOtp(e164, code);
    return res.json({
      ok: true,
      mock: false,
      phone: e164,
      message: "A verification code has been sent by SMS.",
    });
  }

  // Fallback: Supabase phone auth sends the OTP via its configured provider.
  const { error } = await supabaseAnon.auth.signInWithOtp({
    phone: e164,
    options: { channel: "sms" },
  });
  if (error) throw new ApiError(400, error.message);

  res.json({ ok: true, mock: false, phone: e164, message: "A verification code has been sent by SMS." });
}

/** POST /api/auth/phone/verify — verifies the OTP and returns a session. */
export async function verifyPhoneOtp(req: Request, res: Response) {
  const { phone, code, email, mode, fullName } = phoneVerifySchema.parse(req.body);
  const e164 = toE164(phone);

  // Re-enforce the signin/signup rules at verify time (defense in depth).
  if (mode === "signup" && !fullName) {
    throw new ApiError(400, "Please enter your name to create an account.");
  }
  const { exists, error: lookupError } = await accountExists(e164);
  if (!lookupError) {
    if (mode === "signup" && exists) {
      throw new ApiError(409, "This number is already registered. Please sign in instead.");
    }
    if (mode === "signin" && !exists) {
      throw new ApiError(404, "No account found for this number. Please create an account first.");
    }
  }

  const successMsg = mode === "signup" ? "Account created." : "Signed in.";

  if (env.otpMock) {
    if (code !== env.OTP_TEST_CODE) throw new ApiError(401, "Invalid code.");
    await finalizeAuth(e164, { mode, email: email || undefined, fullName });
    return res.json({
      ok: true,
      mock: true,
      message: `${successMsg} (mock mode).`,
      data: phoneSession(e164, await storedName(e164)),
    });
  }

  // WhatsApp / Twilio-direct: verify against the code we generated + sent, then
  // issue a lightweight session (same shape the mock path returns).
  if (whatsappConfigured || twilioConfigured) {
    const result = checkOtp(e164, code);
    if (!result.ok) throw new ApiError(401, result.reason ?? "Invalid code.");
    await finalizeAuth(e164, { mode, email: email || undefined, fullName });
    return res.json({
      ok: true,
      mock: false,
      message: successMsg,
      data: phoneSession(e164, await storedName(e164)),
    });
  }

  // Fallback: Supabase validates the OTP and returns a session.
  const { data, error } = await supabaseAnon.auth.verifyOtp({
    phone: e164,
    token: code,
    type: "sms",
  });
  if (error) throw new ApiError(401, error.message);

  await finalizeAuth(e164, { mode, email: email || undefined, fullName });
  res.json({
    ok: true,
    mock: false,
    message: successMsg,
    data: {
      user: {
        id: data.user?.id ?? e164,
        phone: data.user?.phone ?? e164,
        name: await storedName(e164),
      },
      session: {
        access_token: data.session?.access_token ?? crypto.randomUUID(),
        token_type: "bearer",
      },
    },
  });
}

/**
 * PATCH /api/auth/profile — updates the signed-in customer's display name.
 * Identity is the phone number, matching the rest of the phone-OTP session
 * model (no separate bearer-token verification, same as /orders?phone=).
 */
export async function updateProfileName(req: Request, res: Response) {
  const { phone, name } = updateNameSchema.parse(req.body);
  const e164 = toE164(phone);

  const { error } = await supabaseAdmin
    .from("users")
    .update({ full_name: name })
    .eq("phone", e164);
  if (error) throw new ApiError(500, "Could not save your name. Please try again.");

  res.json({ ok: true, message: "Name updated.", data: { name } });
}
