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
