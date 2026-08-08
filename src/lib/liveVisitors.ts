import { supabaseAdmin } from "./supabase.js";
import { reverseGeocode } from "./reverseGeocode.js";

/**
 * Live-visitor presence.
 *
 * Storefront pages send a heartbeat every ~25s; a visitor counts as online
 * while seen within LIVE_TTL_MS, and drops off automatically once they stop.
 *
 * Presence is stored in Postgres rather than process memory because the API
 * runs on Vercel serverless — heartbeats and admin reads routinely land on
 * different instances, so an in-memory Map would report the wrong count.
 *
 * This models presence only: who is online, and roughly where. Nothing about
 * which page they are on, what they viewed, or how long they stayed.
 */

/**
 * Online if seen within this window. The beacon beats every 25s, so 40s
 * tolerates one dropped request but no more — a closed tab disappears in well
 * under a minute instead of lingering for over one, which made the count read
 * higher than the number of people actually on the site.
 */
const LIVE_TTL_MS = 40_000;

export interface VisitorPing {
  sessionId: string;
  /** Customer name when signed in. */
  name?: string;
  phone?: string;
  /** Approximate location resolved from the request IP at the edge. */
  geo?: EdgeGeo;
  /**
   * A browser GPS fix, sent only after the visitor consented. Takes precedence
   * over the IP guess, which routinely reports the ISP's routing city rather
   * than the visitor's town.
   */
  coords?: { latitude: number; longitude: number };
  /** Fallbacks used only when the edge gave us nothing. */
  tz?: string;
  locale?: string;
}

export interface EdgeGeo {
  countryCode?: string;
  country?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

const COUNTRY_NAMES: Record<string, string> = {
  IN: "India", US: "United States", GB: "United Kingdom", AE: "United Arab Emirates",
  CA: "Canada", AU: "Australia", SG: "Singapore", DE: "Germany", FR: "France",
  NL: "Netherlands", ES: "Spain", IT: "Italy", SA: "Saudi Arabia", JP: "Japan",
  BD: "Bangladesh", PK: "Pakistan", LK: "Sri Lanka", NP: "Nepal", MY: "Malaysia",
  ZA: "South Africa", NZ: "New Zealand", IE: "Ireland", CH: "Switzerland",
  SE: "Sweden", NO: "Norway", BR: "Brazil", MX: "Mexico", CN: "China", KR: "South Korea",
};

/** Regional-indicator flag for an ISO-3166 alpha-2 code. */
export function flagFor(cc?: string | null): string {
  if (!cc || cc.length !== 2 || !/^[A-Za-z]{2}$/.test(cc)) return "🌐";
  const base = 0x1f1e6;
  const up = cc.toUpperCase();
  return String.fromCodePoint(base + up.charCodeAt(0) - 65, base + up.charCodeAt(1) - 65);
}

export function countryName(cc?: string | null): string {
  if (!cc) return "Unknown";
  return COUNTRY_NAMES[cc.toUpperCase()] ?? cc.toUpperCase();
}

/** Locale/timezone fallback for local dev, where there are no edge geo headers. */
function fallbackGeo(locale?: string, tz?: string): EdgeGeo {
  const cc = locale?.match(/[-_]([A-Za-z]{2})\b/)?.[1]?.toUpperCase();
  const city = tz ? (tz.split("/").pop() ?? "").replace(/_/g, " ") : undefined;
  return { countryCode: cc, country: cc ? countryName(cc) : undefined, city };
}

/**
 * Records a heartbeat. Upsert on session id, so a visitor is one row however
 * many beats they send, and `last_seen` is what makes them fall offline.
 */
export async function recordPing(p: VisitorPing): Promise<void> {
  const edge = p.geo ?? {};
  const hasEdge = Boolean(edge.countryCode || edge.city);
  const geo = hasEdge ? edge : fallbackGeo(p.locale, p.tz);

  const row: Record<string, unknown> = {
    session_id: p.sessionId,
    display_name: p.name ?? null,
    phone: p.phone ?? null,
    country_code: geo.countryCode ?? null,
    country: geo.country ?? (geo.countryCode ? countryName(geo.countryCode) : null),
    region: geo.region ?? null,
    city: null,
    district: null,
    // Coordinates are never stored: only state + country is ever displayed, so
    // holding a customer's exact position would be data we have no use for.
    latitude: null,
    longitude: null,
    precise: false,
    last_seen: new Date().toISOString(),
  };

  // Resolve whichever coordinates we have to a place name. A consented GPS fix
  // wins; otherwise the edge's IP coordinates are used, which still beats the
  // raw edge fields — those give a state CODE ("GJ") where geocoding gives the
  // name ("Gujarat"). `precise` is what records which source it came from.
  const fix = p.coords
    ? { lat: p.coords.latitude, lon: p.coords.longitude, precise: true }
    : geo.latitude != null && geo.longitude != null
      ? { lat: geo.latitude, lon: geo.longitude, precise: false }
      : null;

  if (fix) {
    row.precise = fix.precise;
    const place = await reverseGeocode(fix.lat, fix.lon);
    if (place) {
      row.region = place.region ?? row.region;
      row.country = place.country ?? row.country;
      row.country_code = place.countryCode ?? row.country_code;
    }
  }

  const { error } = await supabaseAdmin
    .from("live_visitors")
    .upsert(row, { onConflict: "session_id" });

  if (error) {
    // Older databases lack district/precise — retry without them so presence
    // still works before supabase/live-visitors-precise.sql is applied.
    if (error.code === "42703" || error.code === "PGRST204") {
      const { district: _d, precise: _p, ...legacy } = row;
      void _d;
      void _p;
      const { error: retry } = await supabaseAdmin
        .from("live_visitors")
        .upsert(legacy, { onConflict: "session_id" });
      if (retry) console.warn("live visitor not recorded:", retry.message);
      else console.warn("live visitor: run supabase/live-visitors-precise.sql for precise location");
      return;
    }
    console.warn("live visitor not recorded (run supabase/live-visitors.sql):", error.message);
    return;
  }

  // Opportunistic cleanup — cheap, and keeps the table to just who's online.
  void supabaseAdmin
    .from("live_visitors")
    .delete()
    .lt("last_seen", new Date(Date.now() - LIVE_TTL_MS * 4).toISOString())
    .then(() => undefined);
}

/** Marks a session offline immediately (sent on tab close). */
export async function dropPing(sessionId: string): Promise<void> {
  await supabaseAdmin.from("live_visitors").delete().eq("session_id", sessionId);
}

export interface LiveVisitorRow {
  id: string;
  /** Customer name when signed in, otherwise a stable short Visitor ID. */
  label: string;
  loggedIn: boolean;
  country: string;
  countryCode: string | null;
  flag: string;
  region: string | null;
  city: string | null;
  district: string | null;
  /** true = browser GPS. false = approximate, from the request IP. */
  precise: boolean;
  latitude: number | null;
  longitude: number | null;
  since: string;
  lastSeen: string;
}

export interface LiveSnapshot {
  live: number;
  loggedIn: number;
  guests: number;
  visitors: LiveVisitorRow[];
  locations: { countryCode: string; country: string; flag: string; count: number; cities: string[] }[];
  /** False when live-visitors.sql hasn't been applied yet. */
  tableReady: boolean;
}

/** A short, stable, non-identifying label for an anonymous visitor. */
function visitorId(sessionId: string): string {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return `Visitor #${h.toString(36).toUpperCase().slice(0, 5)}`;
}

/** Who is online right now. */
export async function snapshot(): Promise<LiveSnapshot> {
  const cutoff = new Date(Date.now() - LIVE_TTL_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("live_visitors")
    .select("*")
    .gte("last_seen", cutoff)
    .order("last_seen", { ascending: false });

  if (error) {
    return { live: 0, loggedIn: 0, guests: 0, visitors: [], locations: [], tableReady: false };
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  const visitors: LiveVisitorRow[] = rows.map((r) => {
    const name = (r.display_name as string | null) ?? null;
    const cc = (r.country_code as string | null) ?? null;
    return {
      id: r.session_id as string,
      label: name || visitorId(r.session_id as string),
      loggedIn: Boolean(name),
      country: (r.country as string | null) ?? countryName(cc),
      countryCode: cc,
      flag: flagFor(cc),
      region: (r.region as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      district: (r.district as string | null) ?? null,
      precise: Boolean(r.precise),
      latitude: (r.latitude as number | null) ?? null,
      longitude: (r.longitude as number | null) ?? null,
      since: r.first_seen as string,
      lastSeen: r.last_seen as string,
    };
  });

  const byCountry = new Map<string, { countryCode: string; country: string; flag: string; count: number; cities: Set<string> }>();
  for (const v of visitors) {
    const key = v.countryCode ?? "??";
    const e = byCountry.get(key) ?? {
      countryCode: key, country: v.country, flag: v.flag, count: 0, cities: new Set<string>(),
    };
    e.count += 1;
    if (v.city) e.cities.add(v.city);
    byCountry.set(key, e);
  }

  return {
    live: visitors.length,
    loggedIn: visitors.filter((v) => v.loggedIn).length,
    guests: visitors.filter((v) => !v.loggedIn).length,
    visitors,
    locations: [...byCountry.values()]
      .map((e) => ({ ...e, cities: [...e.cities] }))
      .sort((a, b) => b.count - a.count),
    tableReady: true,
  };
}
