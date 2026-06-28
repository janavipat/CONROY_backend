# CONROY — Backend API

REST API for the CONROY storefront, built with **Express + TypeScript** and backed by
**Supabase** (PostgreSQL + Auth). It serves the catalog, captures contact/newsletter
submissions, places orders (with server-side price validation), and proxies Supabase Auth.

---

## 🧱 Tech stack

- **Express 4** + **TypeScript** (ESM)
- **Supabase** (`@supabase/supabase-js`) — Postgres database + Auth
- **Zod** request validation, **Helmet**, **CORS**, **express-rate-limit**, **morgan**

---

## 📁 Structure

```
backend/
├── src/
│   ├── config/env.ts            # validated environment (fail-fast)
│   ├── lib/supabase.ts          # admin (service-role) + anon clients
│   ├── middleware/              # asyncHandler, error handler, ApiError
│   ├── validators/schemas.ts    # Zod schemas
│   ├── controllers/             # products, collections, engagement, orders, auth
│   ├── routes/index.ts          # route table mounted at /api
│   ├── data/catalog.ts          # seed catalog (4 products, 3 collections)
│   ├── app.ts                   # express app factory
│   └── index.ts                 # server entry
├── supabase/schema.sql          # tables, indexes, RLS policies
├── scripts/seed.ts              # populate Supabase with the catalog
├── .env.example
└── package.json
```

---

## 🔌 API reference

Base URL: `http://localhost:4000`

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/health` | Health check |
| GET | `/api/products` | List products (`?search=&color=&fit=`) |
| GET | `/api/products/:handle` | Single product with images |
| GET | `/api/collections` | List collections |
| GET | `/api/collections/:handle` | Collection + its products (`all` = everything) |
| POST | `/api/contact` | Submit contact form → `contacts` |
| POST | `/api/newsletter` | Subscribe → `newsletter_subscribers` |
| POST | `/api/orders` | Create an order (prices resolved server-side) |
| GET | `/api/orders/:id` | Fetch an order with line items |
| POST | `/api/auth/register` | Supabase Auth sign-up |
| POST | `/api/auth/login` | Supabase Auth sign-in (returns session) |
| GET | `/api/auth/me` | Current user (Bearer access token) |
| POST | `/api/auth/phone/start` | Send OTP to a phone (SMS) — `{ phone }` |
| POST | `/api/auth/phone/verify` | Verify OTP, return session — `{ phone, code }` |

All responses are `{ ok: boolean, ... }`. Validation errors return `422` with details.

---

## 🚀 Setup — step by step

### What **you** need to do (Supabase project)

> I can't (and shouldn't) log into your Supabase account. These steps take ~3 minutes.

1. **Create the project** — go to <https://supabase.com>, sign in, click **New project**.
   Pick a name (e.g. `conroy`), set a database password, choose a region, and create it.
2. **Apply the schema** — open **SQL Editor → New query**, paste the entire contents of
   [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. This creates all tables,
   indexes and Row Level Security policies.
3. **Grab your keys** — go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon / public** key → `SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` *(secret — server only)*
4. *(Optional)* **Auth** — under **Authentication → Providers → Email**, turn **"Confirm email"**
   off for quick local testing, or leave it on for production.

### What runs locally (this folder)

```bash
cd backend
npm install
cp .env.example .env        # then paste your three Supabase values into .env
npm run seed                # loads the 4 products + 3 collections into Supabase
npm run dev                 # starts the API on http://localhost:4000
```

Verify it works:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/api/products
curl http://localhost:4000/api/collections/all
```

### Production

```bash
npm run build    # compiles to dist/
npm start        # node dist/src/index.js
```

Deploy anywhere that runs Node (Render, Railway, Fly.io, a VPS, etc.). Set the same env vars
in your host's dashboard and set `CORS_ORIGINS` to your deployed frontend URL.

---

## 🔗 Connecting the frontend (optional)

The Next.js app in `../frontend` already has an Axios layer (`src/services/`) and reads
`NEXT_PUBLIC_API_BASE_URL`. To point it at this backend, add to `frontend/.env.local`:

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api
```

The contact form and newsletter will then POST to this API. To serve the catalog from
Supabase too, swap the imports in the frontend pages from `lib/products.ts` to a fetch of
`/api/products` / `/api/collections/:handle` (left as a clean follow-up so the storefront
keeps working out of the box).

---

## 📱 Phone OTP login (SMS)

Phone-number login is built on **Supabase phone auth** (SMS only — no voice call).

### Mock mode (default — works now, no provider needed)
With `OTP_MOCK=true` (or whenever Supabase isn't configured), no real SMS is sent
and the fixed `OTP_TEST_CODE` (default `123456`) is accepted. This lets you build and
test the entire login flow locally:

```bash
curl -X POST http://localhost:4000/api/auth/phone/start  -H "Content-Type: application/json" -d '{"phone":"9998009904"}'
curl -X POST http://localhost:4000/api/auth/phone/verify -H "Content-Type: application/json" -d '{"phone":"9998009904","code":"123456"}'
```

Bare 10-digit numbers are normalised to E.164 using `OTP_DEFAULT_COUNTRY_CODE` (`+91`).

### Enabling real SMS (production)
1. In the **Supabase Dashboard → Authentication → Providers → Phone**, enable **Phone**.
2. Connect an **SMS provider** (Twilio, MessageBird, Vonage, Textlocal or MSG91 via custom hook).
3. **India:** complete **DLT registration** (TRAI requirement for transactional SMS) and
   register your OTP template with the provider — this can take a few days.
4. Set `OTP_MOCK=false` in `backend/.env` and add your `SUPABASE_*` keys.

> Voice-call OTP is **not** supported by Supabase phone auth. To add a "call" channel,
> swap the delivery layer for **Twilio Verify** (`channel: "call"`) and mint the Supabase
> session after verification.

## 🔐 Security notes

- The **service-role key bypasses RLS** — keep it only in the backend `.env`, never in the
  frontend or git. `.env` is gitignored.
- Orders **recompute prices from the database**; client-supplied prices are ignored.
- RLS is enabled on every table: the catalog is world-readable, contact/newsletter accept
  inserts, and orders are reachable only through this API (service-role).
- CORS is locked to `CORS_ORIGINS`; a basic rate limit guards `/api`.
