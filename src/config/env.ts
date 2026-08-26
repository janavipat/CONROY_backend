import dotenv from "dotenv";
import { z } from "zod";

// `.env` is committed (existing project convention). `.env.local` is
// gitignored and, if present, overrides it — for secrets that must never
// land in git history (e.g. the Delhivery API token: production-only,
// server-side-only, never to be committed).
dotenv.config();
dotenv.config({ path: ".env.local", override: true });

/** Validates and exposes a typed, fail-fast view of the environment. */
const EnvSchema = z.object({
  // Supabase is optional so the server can boot in OTP mock mode before keys
  // are configured. Catalog/orders/real-auth require these to be set.
  SUPABASE_URL: z.string().default(""),
  SUPABASE_ANON_KEY: z.string().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),

  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  // Phone OTP. In mock mode no real SMS is sent and OTP_TEST_CODE is accepted,
  // so the full login flow can be built/tested before a Supabase SMS provider
  // (Twilio/MSG91 + DLT) is configured.
  OTP_MOCK: z.string().default("true"),
  OTP_TEST_CODE: z.string().default("123456"),
  // Default country code applied to bare local numbers (India).
  OTP_DEFAULT_COUNTRY_CODE: z.string().default("+91"),

  // WhatsApp Cloud API (OTP via WhatsApp — no SMS, so no India DLT needed).
  // ACCESS_TOKEN is SECRET — server-side only. Free for ~1,000 conversations/mo.
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_TEMPLATE_NAME: z.string().default(""),
  WHATSAPP_TEMPLATE_LANG: z.string().default("en_US"),
  WHATSAPP_OTP_BUTTON: z.string().default("true"),

  // WhatsApp order/refund lifecycle notifications ("utility" templates, sent
  // from the same number as OTP). Each template name is overridable so a
  // rename in WhatsApp Manager is a config change, not a code change.
  // Set WHATSAPP_NOTIFY_ENABLED=false to silence every lifecycle message
  // without unsetting the shared credentials that OTP also depends on.
  WHATSAPP_NOTIFY_ENABLED: z.string().default("true"),
  // Language of the notification templates. Empty → falls back to
  // WHATSAPP_TEMPLATE_LANG. Must match Meta exactly ("en" ≠ "en_US").
  WHATSAPP_NOTIFY_LANG: z.string().default(""),
  // The WhatsApp Business Account id (WhatsApp Manager → Account tools).
  // Only needed by GET /api/admin/whatsapp/templates, which reads the live
  // templates back from Meta to verify names and variable counts.
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(""),
  WHATSAPP_TPL_ORDER_CONFIRMED: z.string().default("conroy_order_confirmed"),
  WHATSAPP_TPL_ORDER_SHIPPED: z.string().default("conroy_order_shipped"),
  WHATSAPP_TPL_ORDER_OUT_FOR_DELIVERY: z.string().default("conroy_order_out_for_delivery"),
  WHATSAPP_TPL_ORDER_DELIVERED: z.string().default("conroy_order_delivered"),
  WHATSAPP_TPL_ORDER_CANCELLED: z.string().default("conroy_order_cancelled"),
  WHATSAPP_TPL_REFUND_INITIATED: z.string().default("conroy_refund_initiated"),
  WHATSAPP_TPL_REFUND_COMPLETED: z.string().default("conroy_refund_completed"),

  // Twilio (OTP SMS provider, sent directly from the backend). Auth token is
  // SECRET — server-side only. TWILIO_FROM must be a Twilio-owned number (or use
  // a Messaging Service SID); a personal mobile number can't be a sender.
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_FROM: z.string().default(""),
  TWILIO_MESSAGING_SERVICE_SID: z.string().default(""),

  // MSG91 (legacy OTP SMS provider — unused, kept for reference).
  MSG91_AUTH_KEY: z.string().default(""),
  MSG91_TEMPLATE_ID: z.string().default(""),
  MSG91_OTP_LENGTH: z.coerce.number().default(6),
  MSG91_OTP_EXPIRY_MIN: z.coerce.number().default(10),

  // Razorpay (online payments). Both keys are needed for live checkout; unset →
  // the storefront falls back to free demo checkout. KEY_SECRET is SECRET —
  // server-side only (never expose it to the frontend). KEY_ID is public.
  RAZORPAY_KEY_ID: z.string().default(""),
  RAZORPAY_KEY_SECRET: z.string().default(""),

  // SMTP (welcome/transactional email). Unset → emails are logged, not sent.
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default(""),

  // Firebase (send email via the "Trigger Email" Firestore extension, instead
  // of SMTP directly). All three come from a service account key — Firebase
  // console → Project settings → Service accounts → Generate new private key.
  FIREBASE_PROJECT_ID: z.string().default(""),
  FIREBASE_CLIENT_EMAIL: z.string().default(""),
  FIREBASE_PRIVATE_KEY: z.string().default(""),
  // Firestore collection the Trigger Email extension watches (its default is "mail").
  FIREBASE_MAIL_COLLECTION: z.string().default("mail"),

  // Admin panel key. Required as `x-admin-key` on /api/admin/* when set.
  ADMIN_KEY: z.string().default(""),

  // Delhivery (courier). Set only in .env.local (local dev) and the Vercel
  // dashboard (production) — never in the committed .env. Unset → shipment
  // creation is disabled; nothing else in the app depends on these.
  DELHIVERY_API_URL: z.string().default(""),
  DELHIVERY_API_TOKEN: z.string().default(""),
  DELHIVERY_CLIENT_NAME: z.string().default(""),
  DELHIVERY_PICKUP_LOCATION: z.string().default(""),
  // This Delhivery account has no shared-secret webhook signature available —
  // the long random path segment IS the secret (spec's own fallback: "treat
  // a long random path token as the minimum"). The webhook URL is
  // /api/webhooks/delhivery/<this value>.
  DELHIVERY_WEBHOOK_TOKEN: z.string().default(""),

  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
  // this env var is set — used to verify /api/jobs/shipment/run isn't being
  // hit by anyone else.
  CRON_SECRET: z.string().default(""),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`   • ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const supabaseConfigured = parsed.data.SUPABASE_URL.startsWith("http");
const twilioConfigured = Boolean(
  parsed.data.TWILIO_ACCOUNT_SID &&
    parsed.data.TWILIO_AUTH_TOKEN &&
    (parsed.data.TWILIO_FROM || parsed.data.TWILIO_MESSAGING_SERVICE_SID),
);
const whatsappConfigured = Boolean(
  parsed.data.WHATSAPP_ACCESS_TOKEN &&
    parsed.data.WHATSAPP_PHONE_NUMBER_ID &&
    parsed.data.WHATSAPP_TEMPLATE_NAME,
);
// A real OTP provider is available via WhatsApp, Twilio (direct), or Supabase.
const realOtpProvider = whatsappConfigured || twilioConfigured || supabaseConfigured;

if (!supabaseConfigured) {
  console.warn(
    "⚠️  Supabase not configured — catalog, orders and real auth are disabled.\n" +
      "   Phone OTP runs in MOCK mode. Add SUPABASE_* keys to .env to enable everything.\n",
  );
}

if (!parsed.data.ADMIN_KEY) {
  console.warn("⚠️  ADMIN_KEY is not set — the /admin API is OPEN. Set it before deploying.\n");
}

export const env = {
  ...parsed.data,
  // Fall back to harmless placeholders so the Supabase client can be created
  // without throwing when keys are absent (those endpoints simply won't work).
  SUPABASE_URL: supabaseConfigured ? parsed.data.SUPABASE_URL : "https://placeholder.supabase.co",
  SUPABASE_ANON_KEY: parsed.data.SUPABASE_ANON_KEY || "placeholder-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: parsed.data.SUPABASE_SERVICE_ROLE_KEY || "placeholder-service-key",
  supabaseConfigured,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === "production",
  // OTP is sent either directly via Twilio (TWILIO_* set) or by Supabase phone
  // auth. Force mock OTP unless a real provider is configured, or OTP_MOCK≠false.
  otpMock: parsed.data.OTP_MOCK !== "false" || !realOtpProvider,
};
