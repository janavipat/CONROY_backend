import { supabaseAdmin } from "./supabase.js";

/**
 * Store settings persist as a single JSON object in Supabase Storage (object
 * storage) — no DB migration needed. Storage's CDN can serve stale reads right
 * after a write, so the running process keeps an in-memory cache as the source
 * of truth: reads always reflect the most recent save, and storage is only used
 * to survive restarts. (Single-instance backends stay perfectly consistent;
 * multiple instances converge on the next reload.)
 */
const BUCKET = "app-config";
const PATH = "site-settings.json";

let bucketReady = false;
let cache: SettingsMap | null = null;

export type SettingsMap = Record<string, string>;

/** Creates the private config bucket on first use (idempotent). */
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (!data) await supabaseAdmin.storage.createBucket(BUCKET, { public: false });
  bucketReady = true;
}

/** Loads settings from storage into the cache once, then reuses the cache. */
async function load(): Promise<SettingsMap> {
  if (cache) return cache;
  try {
    await ensureBucket();
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(PATH);
    if (error || !data) {
      cache = {};
    } else {
      const text = Buffer.from(await data.arrayBuffer()).toString("utf-8");
      const parsed = JSON.parse(text) as unknown;
      cache = parsed && typeof parsed === "object" ? (parsed as SettingsMap) : {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

/** Reads the current settings map (from the in-memory source of truth). */
export async function readSettings(): Promise<SettingsMap> {
  return { ...(await load()) };
}

/** Merges a patch into settings, updates the cache immediately, and persists. */
export async function writeSettings(patch: SettingsMap): Promise<void> {
  const next = { ...(await load()), ...patch };
  cache = next; // authoritative for subsequent reads in this process
  await ensureBucket();
  const body = Buffer.from(JSON.stringify(next, null, 2), "utf-8");
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(PATH, body, { contentType: "application/json", upsert: true, cacheControl: "0" });
  if (error) throw new Error(error.message);
}
