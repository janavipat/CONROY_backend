/**
 * Turns GPS coordinates into a place name, server-side.
 *
 * Done on the backend rather than in the browser so the visitor's exact
 * coordinates are never handed to a third party from their own device, and so
 * the lookup can be cached across everyone.
 *
 * BigDataCloud's reverse-geocode endpoint is used because it needs no API key
 * and no account. Results are cached by coordinates rounded to ~1km, which is
 * far finer than a city yet collapses the repeated lookups a heartbeat every
 * 25s would otherwise cause.
 */

export interface Place {
  city?: string;
  district?: string;
  region?: string;
  country?: string;
  countryCode?: string;
}

const cache = new Map<string, Place>();
const MAX_CACHE = 500;
const TIMEOUT_MS = 4000;

/** ~1.1km precision — enough to separate towns, coarse enough to cache well. */
function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

interface AdminArea {
  name?: string;
  description?: string;
  adminLevel?: number;
  isoName?: string;
}

/**
 * Picks the district from the administrative hierarchy. India's districts sit
 * at admin level 5; falling back to a name containing "District" covers other
 * countries that label it differently.
 */
function districtFrom(areas: AdminArea[]): string | undefined {
  const byLevel = areas.find((a) => a.adminLevel === 5)?.name;
  if (byLevel) return byLevel.replace(/\s+district$/i, "");
  const byName = areas.find((a) => /district/i.test(a.name ?? "") || /district/i.test(a.description ?? ""));
  return byName?.name?.replace(/\s+district$/i, "");
}

export async function reverseGeocode(lat: number, lon: number): Promise<Place | null> {
  const key = cacheKey(lat, lon);
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    const url =
      `https://api.bigdatacloud.net/data/reverse-geocode-client` +
      `?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;

    const j = (await res.json()) as {
      city?: string;
      locality?: string;
      principalSubdivision?: string;
      countryName?: string;
      countryCode?: string;
      localityInfo?: { administrative?: AdminArea[] };
    };

    const areas = j.localityInfo?.administrative ?? [];
    const place: Place = {
      // `locality` is the town (Dhrol); `city` can be the larger nearby centre.
      city: j.locality || j.city || undefined,
      district: districtFrom(areas),
      region: j.principalSubdivision || undefined,
      country: j.countryName || undefined,
      countryCode: j.countryCode || undefined,
    };

    if (!place.city && !place.region && !place.country) return null;

    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(key, place);
    return place;
  } catch {
    // Never let a geocoding outage break the heartbeat.
    return null;
  }
}
