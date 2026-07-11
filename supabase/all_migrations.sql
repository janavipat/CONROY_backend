-- ============================================================================
-- CONROY — ALL migrations, consolidated. Paste into Supabase → SQL Editor and Run.
-- Idempotent & safe to re-run. Order matters: base schema first, then add-ons.
-- ============================================================================


-- ==================== schema.sql ====================
-- ============================================================================
-- CONROY storefront — Supabase / PostgreSQL schema
-- Run this in the Supabase Dashboard → SQL Editor (or via the Supabase CLI).
-- Safe to re-run: uses IF NOT EXISTS and idempotent policy drops.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ───────────────────────────── Catalog ─────────────────────────────────────

create table if not exists public.products (
  id            text primary key,
  handle        text not null unique,
  title         text not null,
  tagline       text not null default '',
  description   text not null default '',
  color         text not null,
  fit           text not null,
  price         integer not null check (price >= 0),
  compare_at_price integer,
  currency      text not null default 'INR',
  sizes         text[] not null default '{}',
  details       text[] not null default '{}',
  stock         integer not null default 0,
  rating        numeric(2,1) not null default 0,
  review_count  integer not null default 0,
  badge         text,
  created_at    timestamptz not null default now()
);

create table if not exists public.product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  text not null references public.products(id) on delete cascade,
  src         text not null,
  alt         text not null default '',
  position    integer not null default 0
);
create index if not exists product_images_product_id_idx on public.product_images(product_id);

create table if not exists public.collections (
  handle      text primary key,
  title       text not null,
  subtitle    text not null default '',
  description text not null default '',
  image       text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.collection_products (
  collection_handle text not null references public.collections(handle) on delete cascade,
  product_handle    text not null references public.products(handle) on delete cascade,
  position          integer not null default 0,
  primary key (collection_handle, product_handle)
);

-- ──────────────────────────── Engagement ───────────────────────────────────

create table if not exists public.contacts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null,
  phone      text,
  subject    text not null,
  message    text not null,
  handled    boolean not null default false,
  created_at timestamptz not null default now()
);
-- Backfill for stores created before the admin inbox shipped.
alter table public.contacts add column if not exists handled boolean not null default false;

create table if not exists public.newsletter_subscribers (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────── Orders ────────────────────────────────────

create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  full_name     text,
  phone         text,
  shipping_address text,
  subtotal      integer not null default 0,
  currency      text not null default 'INR',
  status        text not null default 'pending',
  created_at    timestamptz not null default now()
);

create table if not exists public.order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders(id) on delete cascade,
  product_handle text not null,
  title          text not null,
  size           text not null,
  fit            text not null,
  price          integer not null,
  quantity       integer not null check (quantity > 0)
);
create index if not exists order_items_order_id_idx on public.order_items(order_id);

-- ════════════════════════════ Row Level Security ═══════════════════════════
-- The API talks to the DB with the service-role key (which bypasses RLS), so
-- these policies primarily protect the database if the anon key is ever used
-- directly from a browser: catalog is world-readable; writes go through the API.

alter table public.products              enable row level security;
alter table public.product_images        enable row level security;
alter table public.collections           enable row level security;
alter table public.collection_products   enable row level security;
alter table public.contacts              enable row level security;
alter table public.newsletter_subscribers enable row level security;
alter table public.orders                enable row level security;
alter table public.order_items           enable row level security;

-- Public read access to the catalog.
drop policy if exists "catalog_read_products" on public.products;
create policy "catalog_read_products" on public.products for select using (true);

drop policy if exists "catalog_read_images" on public.product_images;
create policy "catalog_read_images" on public.product_images for select using (true);

drop policy if exists "catalog_read_collections" on public.collections;
create policy "catalog_read_collections" on public.collections for select using (true);

drop policy if exists "catalog_read_collection_products" on public.collection_products;
create policy "catalog_read_collection_products" on public.collection_products for select using (true);

-- Allow anonymous inserts for contact + newsletter (so the form could also post
-- directly to Supabase if desired). No select/update/delete for anon.
drop policy if exists "anon_insert_contacts" on public.contacts;
create policy "anon_insert_contacts" on public.contacts for insert with check (true);

drop policy if exists "anon_insert_newsletter" on public.newsletter_subscribers;
create policy "anon_insert_newsletter" on public.newsletter_subscribers for insert with check (true);

-- Orders are intentionally NOT exposed to anon (no policies) — only the API,
-- using the service-role key, may read/write them.


-- ==================== users.sql ====================
-- ============================================================================
-- CONROY — customers (phone-OTP accounts). Run in Supabase → SQL Editor.
-- Used to detect first-time signups (to send the welcome email) and to store
-- the email a shopper provides at signup.
-- ============================================================================

create table if not exists public.users (
  phone       text primary key,
  email       text,
  created_at  timestamptz not null default now()
);

alter table public.users enable row level security;
-- Writes happen through the API (service role); no anon policies needed.


-- ==================== reviews.sql ====================
-- ============================================================================
-- CONROY — product reviews (ratings + feedback + photos)
-- Run this in Supabase → SQL Editor after schema.sql. Safe to re-run.
-- Photos are stored in Supabase Storage; only their URLs live here.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.reviews (
  id             uuid primary key default gen_random_uuid(),
  product_handle text not null references public.products(handle) on delete cascade,
  author         text not null,
  rating         integer not null check (rating between 1 and 5),
  title          text,
  body           text not null default '',
  images         text[] not null default '{}',
  created_at     timestamptz not null default now()
);

create index if not exists reviews_product_idx on public.reviews(product_handle);
create index if not exists reviews_created_idx on public.reviews(created_at desc);

alter table public.reviews enable row level security;

-- Public can read reviews; writes go through the API (service role).
drop policy if exists "reviews_public_read" on public.reviews;
create policy "reviews_public_read" on public.reviews for select using (true);

drop policy if exists "reviews_public_insert" on public.reviews;
create policy "reviews_public_insert" on public.reviews for insert with check (true);


-- ==================== payments.sql ====================
-- ============================================================================
-- CONROY — Razorpay payment references on orders
-- Run this in the Supabase Dashboard → SQL Editor.
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.
--
-- These columns are OPTIONAL — online checkout works without them (the payment
-- reference is simply not stored). Run this migration to record which Razorpay
-- order/payment settled each order.
-- ============================================================================

alter table public.orders
  add column if not exists payment_provider    text,
  add column if not exists razorpay_order_id   text,
  add column if not exists razorpay_payment_id text;

create index if not exists orders_razorpay_payment_id_idx
  on public.orders (razorpay_payment_id);


-- ==================== returns.sql ====================
-- ============================================================================
-- CONROY — order returns / replacements (child records under an order)
-- Run this in Supabase → SQL Editor after schema.sql. Safe to re-run.
--
-- A "return" is a customer request to return or replace some/all items of an
-- order. It snapshots the customer + returned line items, the reason, the
-- requested resolution (refund or replacement), and its processing status.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.returns (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  email       text not null,
  full_name   text,
  phone       text,
  reason      text not null,
  resolution  text not null default 'refund'
              check (resolution in ('refund', 'replacement')),
  status      text not null default 'requested'
              check (status in ('requested', 'approved', 'rejected', 'refunded', 'replaced', 'completed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists returns_order_idx   on public.returns(order_id);
create index if not exists returns_phone_idx   on public.returns(phone);
create index if not exists returns_created_idx on public.returns(created_at desc);

create table if not exists public.return_items (
  id             uuid primary key default gen_random_uuid(),
  return_id      uuid not null references public.returns(id) on delete cascade,
  product_handle text not null,
  title          text not null,
  size           text not null,
  price          integer not null,
  quantity       integer not null check (quantity > 0)
);

create index if not exists return_items_return_idx on public.return_items(return_id);

-- RLS: like orders, returns are only touched by the API (service-role key).
alter table public.returns      enable row level security;
alter table public.return_items enable row level security;


-- ==================== offers.sql ====================
-- ============================================================================
-- CONROY — offers / discounts
-- Run this in Supabase → SQL Editor after schema.sql. Safe to re-run.
--
-- An offer is a single discount rule. Four types:
--   all_products  — applies to the whole cart
--   product       — applies to one product's line items (product_handle)
--   order_above   — applies when subtotal >= min_order_amount
--   code          — applies only when the shopper enters `code` at checkout
--
-- Business rule: only ONE offer may be active at a time (enforced by the API,
-- which deactivates the others when you activate one).
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.offers (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  type             text not null
                   check (type in ('all_products', 'product', 'order_above', 'code')),
  discount_type    text not null default 'percent'
                   check (discount_type in ('percent', 'flat')),
  discount_value   integer not null check (discount_value >= 0),
  product_handle   text,               -- for type 'product'
  min_order_amount integer,            -- for type 'order_above'
  code             text,               -- for type 'code'
  active           boolean not null default false,
  created_at       timestamptz not null default now()
);

create index if not exists offers_active_idx on public.offers(active);

alter table public.offers enable row level security;

-- Discount fields recorded on each order (best-effort; safe to re-run).
alter table public.orders
  add column if not exists discount   integer not null default 0,
  add column if not exists offer_code text;


-- ==================== inventory.sql ====================
-- ============================================================================
-- CONROY — inventory fields on products (SKU + status)
-- Run this in Supabase → SQL Editor after schema.sql. Safe to re-run.
--
-- Adds the fields the admin Inventory section manages: a SKU and a publish
-- status (active / draft / archived). Stock already exists on products.
-- ============================================================================

alter table public.products
  add column if not exists sku    text,
  add column if not exists status text not null default 'active';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_status_check') then
    alter table public.products
      add constraint products_status_check check (status in ('active', 'draft', 'archived'));
  end if;
end $$;

create index if not exists products_status_idx on public.products (status);


-- ==================== analytics.sql ====================
-- ============================================================================
-- CONROY — storefront analytics + wishlist
-- Run this in Supabase → SQL Editor after schema.sql. Safe to re-run.
--
--   page_views     — every page view with time-on-page (for "which page, how
--                    long, how many times")
--   cart_adds      — every add-to-cart (to find products added but not bought)
--   product_likes  — wishlist / likes (which products customers love)
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.page_views (
  id          uuid primary key default gen_random_uuid(),
  session_id  text not null,
  path        text not null,
  duration_ms integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists page_views_path_idx    on public.page_views (path);
create index if not exists page_views_created_idx on public.page_views (created_at desc);

create table if not exists public.cart_adds (
  id             uuid primary key default gen_random_uuid(),
  session_id     text not null,
  product_handle text not null,
  created_at     timestamptz not null default now()
);
create index if not exists cart_adds_product_idx on public.cart_adds (product_handle);

create table if not exists public.product_likes (
  id             uuid primary key default gen_random_uuid(),
  product_handle text not null,
  user_key       text not null,          -- signed-in phone, or an anon browser id
  created_at     timestamptz not null default now(),
  unique (product_handle, user_key)
);
create index if not exists product_likes_product_idx on public.product_likes (product_handle);
create index if not exists product_likes_user_idx    on public.product_likes (user_key);

alter table public.page_views    enable row level security;
alter table public.cart_adds     enable row level security;
alter table public.product_likes enable row level security;

