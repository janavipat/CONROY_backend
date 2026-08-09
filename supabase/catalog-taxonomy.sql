-- ═══════════════════ Catalog taxonomy & merchandising flags ═════════════════
-- Separates the four concepts that were previously collapsed into `fit`:
--
--   Product Type  what the garment is        Jeans, T-Shirt
--   Category      the department             Denim, T-Shirts
--   Fit           how it is cut              Slim Fit, Straight Fit, Relaxed Fit
--   Collection    merchandising grouping     Vintage, Essentials  (join table)
--
-- Plus admin-controlled New In / Best Seller, which are deliberately NOT
-- derived from created_at or sales volume.
--
-- Additive only: nothing is dropped or renamed, and every column has a default
-- that matches the current catalogue, so existing reads keep working untouched.
--
-- Run in Supabase → SQL Editor. TWO PASSES — the indexes reference columns the
-- ALTER in the same script is adding, and Postgres validates the whole script
-- before executing any of it. Run PART 1, clear the editor, run PART 2.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- ══════════════════ PART 1 — columns (run this alone first) ═════════════════

alter table public.products
  -- Every product in the catalogue today is denim, so these defaults are the
  -- backfill: no per-row update is needed for the existing 11 products.
  add column if not exists product_type text not null default 'Jeans',
  add column if not exists category     text not null default 'Denim',

  -- Filterable colour facet. `color` stays the customer-facing merchandising
  -- name ("Jet Black"); this is the bucket it filters into ("Black").
  add column if not exists standard_color text,

  -- Merchandising, admin-controlled. Defaults keep every existing product OUT
  -- of both rails until someone deliberately opts it in.
  add column if not exists is_new_in         boolean not null default false,
  add column if not exists new_in_order      integer,
  add column if not exists is_best_seller    boolean not null default false,
  add column if not exists best_seller_order integer;


-- ══════════════ PART 2 — indexes (run after PART 1 succeeds) ════════════════

-- create index if not exists products_category_fit_idx
--   on public.products (category, fit);
-- create index if not exists products_standard_color_idx
--   on public.products (standard_color);
-- create index if not exists products_new_in_idx
--   on public.products (is_new_in, new_in_order) where is_new_in;
-- create index if not exists products_best_seller_idx
--   on public.products (is_best_seller, best_seller_order) where is_best_seller;
