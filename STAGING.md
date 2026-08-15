# CONROY backend — staging

The `staging` branch. Same code as `main` plus an environment-gated test mode.
It is deployed as its **own Vercel project**, against its **own Supabase
project**, with **Razorpay test keys**. Nothing here touches production.

## What makes it staging

One variable: `APP_ENV=staging`. Unset, this branch behaves exactly like
production — the switch is never inferred from the branch name.

| Variable | Effect |
| --- | --- |
| `APP_ENV=staging` | Turns the test mode on. Nothing below applies without it. |
| `STAGING_PRICE_OVERRIDE_INR=1` | Every product costs ₹1 — on the grid, in the cart, and in the amount Razorpay charges. |

The override is applied in three places, all routed through
[`src/config/staging.ts`](src/config/staging.ts): the two product mappers
(`products.controller.ts`, `collections.controller.ts`) and the cart resolver
(`lib/pricing.ts`). Because the cart resolver is what the payment controller
charges, the price shown and the price charged cannot drift apart.

Coupon offers are suppressed while the override is on — a live "₹200 off" offer
against a ₹1 cart leaves ₹0 payable, which Razorpay rejects.

## Guardrails

Both fail the boot loudly rather than degrading quietly.

- **Production database.** This build refuses to start if `SUPABASE_URL` points
  at a production project ref. Enforced regardless of `APP_ENV`, because a build
  of this branch is never the production deployment.
- **Live payment keys.** With `APP_ENV=staging`, an `rzp_live_…` key is refused.
  A real card can't be charged from here.

## Configuration

There is deliberately **no committed `.env` on this branch** (production's has
one). Everything comes from the host's dashboard. See
[`.env.staging.example`](.env.staging.example) for the full annotated list.

## Verifying a deployment

```bash
curl https://<staging-api>/health
```

```json
{
  "ok": true,
  "service": "conroy-backend",
  "env": "staging",
  "staging": { "supabaseRef": "…", "priceOverrideInr": 1, "razorpayMode": "test" }
}
```

`env: "production"` here, or a `supabaseRef` matching the live project, means
the environment variables are wrong — stop and fix before sharing the URL.

```bash
curl https://<staging-api>/api/products | head -c 400   # every price should be 1
```

## Database

The staging Supabase project needs the schema applied once — paste
[`supabase/all_migrations.sql`](supabase/all_migrations.sql) into its SQL Editor
and run it, then `npm run seed` against the staging keys to load the catalogue.

## Login

`OTP_MOCK=true` — any phone number signs in with `OTP_TEST_CODE` (default
`123456`). No SMS or WhatsApp message is sent and no provider credit is spent.
