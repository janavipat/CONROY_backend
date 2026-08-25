-- ============================================================================
-- CONROY — saved delivery addresses. Run in Supabase → SQL Editor.
--
-- Replaces the addresses.json blob in Storage, which held every customer's
-- addresses in a single object behind a per-instance cache: two customers
-- saving at the same time, on different serverless instances, could overwrite
-- one another. Rows in a table cannot do that.
--
-- An address here is the customer's ADDRESS BOOK. It is deliberately separate
-- from the ship_* columns on `orders`, which are a snapshot taken when the
-- order was placed — editing a saved address must never rewrite the address a
-- past order was delivered to.
--
-- Safe to run more than once.
-- ============================================================================

create table if not exists public.customer_addresses (
  id uuid primary key default gen_random_uuid(),

  -- The customer, by the same phone identity the rest of the store uses.
  -- Cascades so removing a customer cannot leave their addresses behind.
  customer_phone text not null references public.users(phone) on delete cascade,

  full_name text not null,
  phone     text not null,
  line1     text not null,
  line2     text,
  city      text not null,
  state     text not null,
  pincode   text not null,

  label      text not null default 'Home',
  is_default boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every read is "this customer's addresses".
create index if not exists customer_addresses_customer_idx
  on public.customer_addresses (customer_phone, created_at desc);

-- At most one default per customer, enforced by the database rather than by
-- whichever code path happened to write last.
create unique index if not exists customer_addresses_one_default_idx
  on public.customer_addresses (customer_phone)
  where is_default;

alter table public.customer_addresses enable row level security;

-- No anon/authenticated policies: every read and write goes through the API
-- using the service role, exactly as `users` and `orders` do. Without a policy
-- the anon key can reach nothing here, which is the intent — a shopper must
-- never be able to query another customer's addresses directly from a browser.
