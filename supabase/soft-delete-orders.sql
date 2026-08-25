-- Soft delete for orders.
--
-- Deleting an order used to remove the row, which took its items, shipment,
-- waybill and cancellation record with it via `on delete cascade` — an
-- irreversible loss of the only evidence of what happened. An order is now
-- marked deleted instead: it leaves the working lists, keeps every related
-- record intact, and can be restored. Permanent removal stays available, but
-- only as a deliberate second step from the Deleted Orders section.
--
-- Safe to run more than once.

alter table public.orders add column if not exists deleted_at timestamptz;
alter table public.orders add column if not exists deleted_by text;

-- Every working query filters on `deleted_at is null`, so this is the index
-- that keeps the orders list from degrading as deleted rows accumulate.
create index if not exists orders_deleted_at_idx
  on public.orders (deleted_at)
  where deleted_at is null;
