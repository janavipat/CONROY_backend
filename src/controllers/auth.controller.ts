import type { Request, Response } from "express";
import { supabaseAnon } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { sendWelcomeEmail } from "../lib/email.js";
import { authSchema, phoneStartSchema, phoneVerifySchema } from "../validators/schemas.js";

/** Builds a lightweight session for a verified phone number. */
function phoneSession(e164: string) {
  return {
    user: { id: e164, phone: e164 },
    session: { access_token: crypto.randomUUID(), token_type: "bearer" },
  };
}

/**
 * Records the customer on first sign-in and, if it's a brand-new signup with an
 * email, sends the welcome email. Best-effort — never blocks login.
 */
async function onSignedIn(e164: string, email?: string): Promise<void> {
  try {
    // Insert-first: success == brand-new signup; 23505 == returning user.
    const { error } = await supabaseAdmin
      .from("users")
      .insert({ phone: e164, email: email || null });

    if (!error) {
      if (email) {
        // Fire-and-forget so a slow SMTP server never delays sign-in.
        void sendWelcomeEmail(email).catch((err) =>
          console.error("Welcome email failed:", err instanceof Error ? err.message : err),
        );
      }
      return;
    }

    // Returning user — keep their email current; any other error (e.g. the
    // users table not created yet) is ignored so login never breaks.
    if (error.code === "23505" && email) {
      await supabaseAdmin.from("users").update({ email }).eq("phone", e164);
    }
  } catch (err) {
    console.error("User upsert skipped:", err instanceof Error ? err.message : err);
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
  const { phone } = phoneStartSchema.parse(req.body);
  const e164 = toE164(phone);

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

  // Real mode: Supabase phone auth sends the OTP via the configured provider
  // (Twilio) and creates the user on first sign-in.
  const { error } = await supabaseAnon.auth.signInWithOtp({
    phone: e164,
    options: { channel: "sms" },
  });
  if (error) throw new ApiError(400, error.message);

  res.json({ ok: true, mock: false, phone: e164, message: "A verification code has been sent by SMS." });
}

/** POST /api/auth/phone/verify — verifies the OTP and returns a session. */
export async function verifyPhoneOtp(req: Request, res: Response) {
  const { phone, code, email } = phoneVerifySchema.parse(req.body);
  const e164 = toE164(phone);

  if (env.otpMock) {
    if (code !== env.OTP_TEST_CODE) throw new ApiError(401, "Invalid code.");
    await onSignedIn(e164, email || undefined);
    return res.json({
      ok: true,
      mock: true,
      message: "Signed in (mock mode).",
      data: phoneSession(e164),
    });
  }

  // Real mode: Supabase validates the OTP and returns a session.
  const { data, error } = await supabaseAnon.auth.verifyOtp({
    phone: e164,
    token: code,
    type: "sms",
  });
  if (error) throw new ApiError(401, error.message);

  await onSignedIn(e164, email || undefined);
  res.json({
    ok: true,
    mock: false,
    message: "Signed in.",
    data: {
      user: { id: data.user?.id ?? e164, phone: data.user?.phone ?? e164 },
      session: {
        access_token: data.session?.access_token ?? crypto.randomUUID(),
        token_type: "bearer",
      },
    },
  });
}
