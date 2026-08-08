-- ═══════════════════════════ Live visitors ══════════════════════════════════
-- Powers Admin → Analytics → Live visitors.
--
-- Presence has to live in the database, not in process memory: the API runs on
-- Vercel serverless, so each request can hit a different short-lived instance.
-- An in-memory Map would mean the admin reads a different instance's memory
-- from the one that received the heartbeat, and the count would be wrong.
--
-- This is presence, not history: one row per session, overwritten on each
-- heartbeat, deleted once stale. Nothing about pages or behaviour is stored.
--
-- Run in Supabase → SQL Editor. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.live_visitors (
  session_id   text primary key,
  -- Customer name when signed in; null means an anonymous visitor.
  display_name text,
  phone        text,
  -- Approximate, from the request IP at the edge. Never GPS.
  country_code text,
  country      text,
  region       text,
  city         text,
  latitude     double precision,
  longitude    double precision,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

create index if not exists live_visitors_last_seen_idx
  on public.live_visitors (last_seen desc);

-- The API talks to the DB with the service-role key (which bypasses RLS), so
-- this just needs to be ON with no policies — that blocks the anon/authenticated
-- keys (which are public, embedded in frontend JS) from reading rows directly,
-- including phone numbers, over the auto-generated REST API.
alter table public.live_visitors enable row level security;
