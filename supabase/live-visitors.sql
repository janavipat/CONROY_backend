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
-- Run in Supabase → SQL Editor. TWO PASSES — the index references the table
-- created in the same script. Run PART 1, clear the editor, run PART 2.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- ══════════════════ PART 1 — table (run this alone first) ═══════════════════

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


-- ══════════════ PART 2 — index (run after PART 1 succeeds) ══════════════════

-- create index if not exists live_visitors_last_seen_idx
--   on public.live_visitors (last_seen desc);
