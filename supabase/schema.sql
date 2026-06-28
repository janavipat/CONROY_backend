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
  created_at timestamptz not null default now()
);

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
