-- ═════════════════ Live visitors: precise (GPS) location ════════════════════
-- Adds the district level and a flag separating a GPS fix from an IP guess.
--
-- IP geolocation resolves to the ISP's routing city, which in Gujarat commonly
-- lands on Vadodara/Ahmedabad regardless of where the visitor actually is. A
-- browser GPS fix is accurate to metres, so the two must be distinguishable in
-- the admin — an approximate row should never be read as exact.
--
-- Run in Supabase → SQL Editor. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.live_visitors
  -- e.g. "Jamnagar" for a visitor in Dhrol.
  add column if not exists district text,
  -- true = browser GPS (consented). false = approximate, from the request IP.
  add column if not exists precise boolean not null default false;
