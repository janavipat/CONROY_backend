-- Order cancellation + fulfilment lifecycle.
-- Run this on an existing database (it is also included in all_migrations.sql).
--
-- NOTE: `orders.status` already stores the PAYMENT state ('paid', 'cod_pending',
-- 'cancelled') and is used for revenue reporting, COD-vs-online detection and
-- analytics. The delivery lifecycle therefore lives in its own column so the
-- two concerns never collide.

alter table public.orders
  add column if not exists fulfillment_status text not null default 'Pending',
  add column if not exists cancel_reason      text,
  add column if not exists cancelled_at       timestamptz,
  add column if not exists cancelled_by       text,
  add column if not exists refund_status      text not null default 'None';

-- Allowed lifecycle values: Pending, Confirmed, Processing, Packed, Shipped,
-- Out For Delivery, Delivered, Cancelled.
alter table public.orders drop constraint if exists orders_fulfillment_status_chk;
alter table public.orders add constraint orders_fulfillment_status_chk
  check (fulfillment_status in (
    'Pending','Confirmed','Processing','Packed','Shipped',
    'Out For Delivery','Delivered','Cancelled'
  ));

-- Allowed refund states: None, Initiated, Processing, Completed, Failed.
alter table public.orders drop constraint if exists orders_refund_status_chk;
alter table public.orders add constraint orders_refund_status_chk
  check (refund_status in ('None','Initiated','Processing','Completed','Failed'));

-- Keep already-cancelled orders consistent with the new lifecycle column.
update public.orders
   set fulfillment_status = 'Cancelled'
 where status = 'cancelled' and fulfillment_status <> 'Cancelled';

create index if not exists orders_fulfillment_status_idx
  on public.orders (fulfillment_status);
