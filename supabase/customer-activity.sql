-- ═══════════════════════ Customer activity & cart history ═══════════════════
-- Powers Admin → Customers → (a customer) → Website activity + Added to cart.
--
-- ⚠ RUN THIS IN TWO PASSES. Postgres parses every statement in a script before
--   executing any of them, so a CREATE INDEX on a column that an earlier ALTER
--   in the same script is about to add fails with:
--       ERROR: 42703: column "phone" does not exist
--   Run PART 1 on its own, then clear the editor and run PART 2.
--
-- Safe to re-run: every statement is idempotent.
-- ─────────────────────────────────────────────────────────────────────────────


-- ══════════════════ PART 1 — columns (run this alone first) ═════════════════

-- Attribute page views to a signed-in customer. Previously a page view only
-- carried a session id, so it could never be tied back to a person.
alter table public.page_views
  add column if not exists phone text,
  add column if not exists email text;

-- Record WHAT was added to the cart, not just that something was. `price` is
-- stored at the moment of adding, so later price changes don't rewrite history.
-- phone/email are included here because older databases may predate them.
alter table public.cart_adds
  add column if not exists phone    text,
  add column if not exists email    text,
  add column if not exists size     text,
  add column if not exists quantity integer not null default 1,
  add column if not exists price    integer,
  add column if not exists currency text not null default 'INR';


-- ══════════════ PART 2 — indexes (run after PART 1 succeeds) ════════════════

-- create index if not exists page_views_phone_idx
--   on public.page_views (phone, created_at desc);
-- create index if not exists page_views_email_idx
--   on public.page_views (email, created_at desc);
-- create index if not exists cart_adds_phone_created_idx
--   on public.cart_adds (phone, created_at desc);
-- create index if not exists cart_adds_email_created_idx
--   on public.cart_adds (email, created_at desc);
