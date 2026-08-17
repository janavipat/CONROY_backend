import type { Request, Response } from "express";
import { supabaseAnon } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { sendWelcomeEmail } from "../lib/email.js";
// Email OTP delivery — commented out in favor of WhatsApp (the original,
// primary channel). Re-enable by uncommenting this import, the emailField/
// superRefine bits in schemas.ts, and the "Email OTP" block below.
// import { sendOtpEmail } from "../lib/email.js";
import { twilioConfigured, sendSms } from "../lib/twilio.js";
import { whatsappConfigured, sendWhatsappOtp } from "../lib/whatsapp.js";
import { generateOtp, saveOtp, checkOtp } from "../lib/otpStore.js";
import {
  // registerSchema, loginSchema — unused while register()/login() are commented out below.
  phoneStartSchema,
  phoneVerifySchema,
  updateNameSchema,
} from "../validators/schemas.js";

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

// Unused now that sign-in is by email (the email lookup in startPhoneOtp /
// verifyPhoneOtp already resolves the account, so there's nothing left to
// look up by phone). Kept for when phone-based sign-in is restored.
// async function storedEmail(e164: string): Promise<string | null> {
//   try {
//     const { data } = await supabaseAdmin.from("users").select("email").eq("phone", e164).maybeSingle();
//     return ((data?.email as string) || "").trim() || null;
//   } catch {
//     return null;
//   }
// }

// Unused now that sign-in is phone-based again. Kept for when email-only
// sign-in is restored (see the matching commented-out bits in schemas.ts and
// startPhoneOtp/verifyPhoneOtp below).
// async function findPhoneByEmail(email: string): Promise<string | null> {
//   try {
//     const { data } = await supabaseAdmin.from("users").select("phone").eq("email", email).maybeSingle();
//     return (data?.phone as string) || null;
//   } catch {
//     return null;
//   }
// }

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

// Unused now that WhatsApp (not email) is the active OTP channel. Kept for
// when email OTP delivery is restored (see the commented-out block below).
// function maskEmail(email: string): string {
//   const [user, domain] = email.split("@");
//   if (!domain || user.length <= 2) return email;
//   return `${user[0]}***${user[user.length - 1]}@${domain}`;
// }

/** Normalises a phone number to E.164, applying the default country code. */
function toE164(raw: string): string {
  const trimmed = raw.replace(/[\s-]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  // Bare 10-digit local number → prepend the default country code.
  return `${env.OTP_DEFAULT_COUNTRY_CODE}${trimmed.replace(/^0+/, "")}`;
}

// Email + password auth — commented out in favor of phone OTP (WhatsApp),
// the original/primary authentication method. Both depend on
// findPhoneByEmail, also commented out above (in auth.controller.ts) — and
// registerSchema/loginSchema (still defined, unused, in schemas.ts). Restore
// all three together, plus the two route registrations in routes/index.ts,
// to bring this back.
//
// /**
//  * POST /api/auth/register — creates a Supabase Auth user (email + password)
//  * and the matching `users` row (phone is still the account's identity in the
//  * DB — orders/addresses/admin all key off it). No email is sent as part of
//  * this: password auth doesn't need a verification code, and the welcome
//  * email is deliberately skipped here (see finalizeAuth, which is only used
//  * by the OTP flow).
//  */
// export async function register(req: Request, res: Response) {
//   const { email, password, fullName, phone } = registerSchema.parse(req.body);
//   const e164 = toE164(phone);
//
//   const { exists, error: lookupError } = await accountExists(e164);
//   if (!lookupError && exists) {
//     throw new ApiError(409, "This number is already registered. Please sign in instead.");
//   }
//
//   const { data: signUpData, error: signUpError } = await supabaseAnon.auth.signUp({ email, password });
//   if (signUpError) throw new ApiError(400, signUpError.message);
//
//   // Supabase's default "Confirm email" flow blocks sign-in until the user
//   // clicks a link Supabase emails them — auto-confirm immediately instead, so
//   // login works right away and no confirmation email is needed at all. (If
//   // "Confirm email" is enabled in the Supabase dashboard, Supabase will still
//   // have sent that one email during signUp() above — that's a project-level
//   // setting, not something this call can suppress in advance.)
//   if (signUpData.user?.id) {
//     const { error: confirmError } = await supabaseAdmin.auth.admin.updateUserById(signUpData.user.id, {
//       email_confirm: true,
//     });
//     if (confirmError) console.warn("Auto-confirm failed:", confirmError.message);
//   }
//
//   const { error: insertError } = await supabaseAdmin
//     .from("users")
//     .insert({ phone: e164, email, full_name: fullName });
//   if (insertError) {
//     // 23505 = unique violation — this number already has a row (race with
//     // the check above, or a stale one); either way it's already registered.
//     if (insertError.code === "23505") {
//       throw new ApiError(409, "This number is already registered. Please sign in instead.");
//     }
//     // Any other error (e.g. full_name column missing) — retry without it so
//     // a not-yet-migrated DB still lets people register.
//     const retry = await supabaseAdmin.from("users").insert({ phone: e164, email });
//     if (retry.error && retry.error.code === "23505") {
//       throw new ApiError(409, "This number is already registered. Please sign in instead.");
//     }
//   }
//
//   res.status(201).json({
//     ok: true,
//     message: "Account created.",
//     data: phoneSession(e164, fullName),
//   });
// }
//
// /**
//  * POST /api/auth/login — verifies email + password against Supabase Auth,
//  * then resolves the matching phone-keyed account (the identity the rest of
//  * the app uses) and issues the same lightweight session the OTP flow does.
//  */
// export async function login(req: Request, res: Response) {
//   const { email, password } = loginSchema.parse(req.body);
//
//   const { error: signInError } = await supabaseAnon.auth.signInWithPassword({ email, password });
//   if (signInError) throw new ApiError(401, "Invalid email or password.");
//
//   const e164 = await findPhoneByEmail(email);
//   if (!e164) {
//     throw new ApiError(404, "Account details not found. Please contact support.");
//   }
//
//   res.json({
//     ok: true,
//     message: "Signed in.",
//     data: phoneSession(e164, await storedName(e164)),
//   });
// }

/** GET /api/auth/me — returns the user for a Bearer access token. */
export async function me(req: Request, res: Response) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw new ApiError(401, "Missing bearer token");

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error) throw new ApiError(401, error.message);

  res.json({ ok: true, data: data.user });
}

/* ───────────────────────── Phone OTP login ──────────────────────────────── */

/** POST /api/auth/phone/start — sends an OTP to the phone (WhatsApp). */
export async function startPhoneOtp(req: Request, res: Response) {
  const { phone, mode } = phoneStartSchema.parse(req.body);
  const e164 = toE164(phone);

  // Email-only sign-in — commented out alongside the schema/import changes.
  // Restore all three together to bring it back.
  // let e164: string;
  // if (mode === "signin") {
  //   const found = await findPhoneByEmail(email as string);
  //   if (!found) {
  //     throw new ApiError(404, "No account found for this email. Please create an account first.");
  //   }
  //   e164 = found;
  // } else {
  //   e164 = toE164(phone as string);
  // }

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

  // WhatsApp Cloud API — the primary channel (no SMS, so no India DLT needed).
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

  // Email OTP — commented out alongside the WhatsApp restore above. Was the
  // active channel while WhatsApp was disabled; re-enable by uncommenting
  // this, the sendOtpEmail import, and maskEmail above.
  // {
  //   const emailTo = mode === "signup" ? email || undefined : (await storedEmail(e164)) || undefined;
  //   if (mode === "signup" && !emailTo) {
  //     throw new ApiError(400, "Please enter your email to receive a verification code.");
  //   }
  //   if (emailTo) {
  //     const code = generateOtp();
  //     await sendOtpEmail(emailTo, code);
  //     saveOtp(e164, code);
  //     return res.json({
  //       ok: true,
  //       mock: false,
  //       phone: e164,
  //       channel: "email",
  //       message: `A verification code has been sent to ${maskEmail(emailTo)}.`,
  //     });
  //   }
  // }

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

  // Email-only sign-in — commented out alongside startPhoneOtp's matching
  // change. Restore together.
  // let e164: string;
  // if (mode === "signin") {
  //   const found = await findPhoneByEmail(email as string);
  //   if (!found) {
  //     throw new ApiError(404, "No account found for this email. Please create an account first.");
  //   }
  //   e164 = found;
  // } else {
  //   e164 = toE164(phone as string);
  // }

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

  // WhatsApp / Twilio-direct: verify against the code we generated + sent,
  // then issue a lightweight session (same shape the mock path returns).
  // checkOtp() is channel-agnostic — it just validates whatever code
  // saveOtp() stored, regardless of which channel sent it.
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
