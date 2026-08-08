-- ═════════════════════════ Live customer cart mirror ════════════════════════
-- Powers Admin → Customers → (a customer) → Cart.
--
-- One row per line item currently in a signed-in customer's cart. The storefront
-- replaces every row for that customer on each change, so removals disappear
-- here too and the table always mirrors what the shopper can actually see.
--
-- This is deliberately separate from `cart_adds`, which stays an append-only
-- history of every add.
--
-- Run in Supabase → SQL Editor. Single pass — no index references a column
-- created in the same script. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.customer_carts (
  id             uuid primary key default gen_random_uuid(),
  phone          text not null,
  email          text,
  product_handle text not null,
  title          text not null,
  image          text,
  size           text not null default '',
  quantity       integer not null default 1,
  price          integer not null default 0,
  currency       text not null default 'INR',
  added_at       timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One row per product+size per customer; a re-add updates the quantity.
  constraint customer_carts_line unique (phone, product_handle, size)
);

create index if not exists customer_carts_phone_idx
  on public.customer_carts (phone, updated_at desc);
