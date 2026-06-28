import type { Request, Response } from "express";
import { supabaseAnon } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { env } from "../config/env.js";
import { authSchema, phoneStartSchema, phoneVerifySchema } from "../validators/schemas.js";

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
      message: `Mock mode — enter ${env.OTP_TEST_CODE} to sign in (no SMS sent).`,
    });
  }

  // Real mode: Supabase sends the OTP via the configured SMS provider and
  // creates the user if they don't exist yet.
  const { error } = await supabaseAnon.auth.signInWithOtp({
    phone: e164,
    options: { channel: "sms" },
  });
  if (error) throw new ApiError(400, error.message);

  res.json({ ok: true, phone: e164, message: "A verification code has been sent by SMS." });
}

/** POST /api/auth/phone/verify — verifies the OTP and returns a session. */
export async function verifyPhoneOtp(req: Request, res: Response) {
  const { phone, code } = phoneVerifySchema.parse(req.body);
  const e164 = toE164(phone);

  if (env.otpMock) {
    if (code !== env.OTP_TEST_CODE) throw new ApiError(401, "Invalid code.");
    // Return a mock session so the frontend flow works end-to-end in dev.
    return res.json({
      ok: true,
      mock: true,
      message: "Signed in (mock mode).",
      data: {
        user: { id: `mock-${e164}`, phone: e164 },
        session: { access_token: "mock-access-token", token_type: "bearer" },
      },
    });
  }

  const { data, error } = await supabaseAnon.auth.verifyOtp({
    phone: e164,
    token: code,
    type: "sms",
  });
  if (error) throw new ApiError(401, error.message);

  res.json({
    ok: true,
    message: "Signed in.",
    data: { user: data.user, session: data.session },
  });
}
