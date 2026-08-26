-- WhatsApp order-lifecycle notifications: the audit log AND the idempotency
-- guard for customer messages.
-- Run this on an existing database (it is also included in all_migrations.sql).
--
-- Why a table and not just a console log: courier webhooks re-deliver, admin
-- screens fire duplicate PATCHes, and a cron reconciliation replays scans. The
-- unique index below is what turns "the same event seen three times" into one
-- WhatsApp message, and it is also the only record support can consult to
-- answer "was this customer actually told?".

create table if not exists public.whatsapp_notifications (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  -- Which lifecycle moment. Mirrors OrderEvent in src/lib/orderNotifications.ts.
  event      text not null,
  -- The approved template name actually used, so a later rename stays traceable.
  template   text not null,
  -- Recipient in E.164. Empty string when the order had no phone (status 'skipped').
  to_phone   text not null default '',
  -- sent    — Meta accepted it (message_id set)
  -- failed  — Meta or the network rejected it (error set); may be retried
  -- skipped — nothing to send: no phone on the order
  status     text not null default 'sent',
  message_id text,
  error      text,
  -- The {{1}}, {{2}}, … values sent, for reproducing what the customer saw.
  params     jsonb,
  created_at timestamptz not null default now()
);

alter table public.whatsapp_notifications
  drop constraint if exists whatsapp_notifications_event_chk;
alter table public.whatsapp_notifications
  add constraint whatsapp_notifications_event_chk
  check (event in (
    'order_confirmed','order_shipped','order_out_for_delivery','order_delivered',
    'order_cancelled','refund_initiated','refund_completed'
  ));

alter table public.whatsapp_notifications
  drop constraint if exists whatsapp_notifications_status_chk;
alter table public.whatsapp_notifications
  add constraint whatsapp_notifications_status_chk
  check (status in ('sent','failed','skipped'));

-- THE IDEMPOTENCY GUARD. Partial, so it only constrains successful sends:
-- one 'sent' row per (order, event) means the customer is messaged once, while
-- 'failed' and 'skipped' rows stay unconstrained so a retry is still allowed.
create unique index if not exists whatsapp_notifications_order_event_uidx
  on public.whatsapp_notifications (order_id, event)
  where status = 'sent';

-- The admin order screen reads this per order, newest first.
create index if not exists whatsapp_notifications_order_idx
  on public.whatsapp_notifications (order_id, created_at desc);

-- Service-role only: the backend writes and reads these, never the browser.
alter table public.whatsapp_notifications enable row level security;
