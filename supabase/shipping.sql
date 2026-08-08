-- ============================================================================
-- CONROY — Delivery & shipping foundation (Delhivery integration, Phase 1+2)
-- Run this in the Supabase Dashboard → SQL Editor. Safe to re-run.
--
-- These columns/tables are OPTIONAL to the existing storefront — checkout and
-- order creation keep working without them (structured address / shipment
-- data is simply not stored, matching how payments.sql/offers.sql work).
-- Run this migration before creating any real shipments.
-- ============================================================================


-- ──────────── Fix: fulfillment_status CHECK constraint was never extended ──
-- cancel-order.sql's orders_fulfillment_status_chk only allowed the original
-- 8 values — Manifested/Attempt Failed/Returning/Returned (added when the
-- Delhivery status-map was built) were silently rejected by Postgres on
-- every write, and createShipmentForOrder didn't check that update's error
-- (found 2026-08-09 testing a real shipment: it was created successfully on
-- Delhivery's side, but the order stayed stuck on "Pending").

alter table public.orders drop constraint if exists orders_fulfillment_status_chk;
alter table public.orders add constraint orders_fulfillment_status_chk
  check (fulfillment_status in (
    'Pending','Confirmed','Processing','Packed',
    'Manifested','Shipped','Out For Delivery','Delivered',
    'Attempt Failed','Returning','Returned','Cancelled'
  ));


-- ─────────────────── Phase 1a — structured shipping address ────────────────
-- `shipping_address` stays as-is (the human-readable display string, e.g. on
-- the packing slip). These are the same values the checkout form already
-- collects, persisted individually so a courier payload never has to
-- reverse-parse free text back into city/state/pincode.

alter table public.orders
  add column if not exists ship_name    text,
  add column if not exists ship_phone   text,
  add column if not exists ship_line1   text,
  add column if not exists ship_line2   text,
  add column if not exists ship_city    text,
  add column if not exists ship_state   text,
  add column if not exists ship_pincode text,
  add column if not exists ship_country text default 'India';


-- ───────────────────── Phase 1b — product shipping info ────────────────────
-- Needed to compute courier charges (actual vs. volumetric weight) and to
-- exclude non-physical products from shipment creation entirely.

alter table public.products
  add column if not exists weight_g     integer,
  add column if not exists length_cm    numeric,
  add column if not exists width_cm     numeric,
  add column if not exists height_cm    numeric,
  add column if not exists is_shippable boolean not null default true;


-- ────────────────────────── Phase 2 — shipments ─────────────────────────────
-- One shipment per order for now (see AGENTS notes for the multi-shipment /
-- multi-warehouse evolution). The API talks to this table with the
-- service-role key, so RLS is ON with no policies — same pattern as every
-- other table in this project.

create table if not exists public.shipments (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,

  provider text not null default 'delhivery',

  waybill text unique,
  ref_no  text not null,

  status text not null default 'pending',

  label_url  text,
  pickup_id  text,

  declared_g           integer,
  actual_weight_g       integer,
  volumetric_weight_g   integer,

  create_response jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shipments_one_per_order unique (order_id)
);

create index if not exists shipments_waybill_idx on public.shipments (waybill);
create index if not exists shipments_status_idx  on public.shipments (status);

alter table public.shipments enable row level security;


-- ────────────────────────── Phase 2 — shipment events ───────────────────────
-- Every courier scan, raw payload included — needed for disputes, debugging,
-- reconciliation and support. `occurred_at` is the courier's own event time
-- (not `received_at`), so out-of-order webhook delivery can still be sorted
-- correctly.

create table if not exists public.shipment_events (
  id uuid primary key default gen_random_uuid(),

  shipment_id uuid references public.shipments(id) on delete cascade,
  waybill     text not null,

  status      text not null,
  status_type text,
  location    text,
  remark      text,

  occurred_at timestamptz not null,
  payload     jsonb not null,
  received_at timestamptz not null default now(),

  constraint shipment_events_dedupe unique (waybill, status, occurred_at)
);

create index if not exists shipment_events_shipment_id_idx
  on public.shipment_events (shipment_id, occurred_at desc);

alter table public.shipment_events enable row level security;


-- ────────────────────────── Phase 2 — shipment jobs ─────────────────────────
-- Database-backed queue: the backend is serverless (Vercel), so there is no
-- long-running process to hold an in-memory queue or retry timer. A cron hits
-- /api/jobs/shipment, which claims due rows with `FOR UPDATE SKIP LOCKED` so
-- overlapping cron runs never double-process the same job.

create table if not exists public.shipment_jobs (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null references public.orders(id) on delete cascade,

  kind  text not null,             -- create | cancel | poll | reconcile
  state text not null default 'queued', -- queued | running | done | dead

  attempts     integer not null default 0,
  next_run_at  timestamptz not null default now(),
  locked_at    timestamptz,
  last_error   text,

  created_at timestamptz not null default now(),

  constraint shipment_jobs_one_open unique (order_id, kind)
);

create index if not exists shipment_jobs_due_idx
  on public.shipment_jobs (state, next_run_at);

alter table public.shipment_jobs enable row level security;
