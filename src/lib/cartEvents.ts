import { supabaseAdmin } from "./supabase.js";

/**
 * Abandoned-cart attribution without a DB migration: when a signed-in shopper
 * adds a product to their cart, we append a small event to a JSON log in
 * Supabase Storage. The admin's "Abandoned checkouts" reads this to show which
 * customer added what but never bought it. An in-memory cache keeps reads fresh
 * (Storage's CDN can serve stale reads right after a write).
 */
const BUCKET = "app-config";
const PATH = "cart-events.json";
const MAX_EVENTS = 5000;

export interface CartEvent {
  phone: string;
  email: string;
  handle: string;
  at: string;
}

let bucketReady = false;
let cache: CartEvent[] | null = null;

async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (!data) await supabaseAdmin.storage.createBucket(BUCKET, { public: false });
  bucketReady = true;
}

async function load(): Promise<CartEvent[]> {
  if (cache) return cache;
  try {
    await ensureBucket();
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(PATH);
    if (error || !data) {
      cache = [];
    } else {
      const text = Buffer.from(await data.arrayBuffer()).toString("utf-8");
      const parsed = JSON.parse(text) as unknown;
      cache = Array.isArray(parsed) ? (parsed as CartEvent[]) : [];
    }
  } catch {
    cache = [];
  }
  return cache;
}

/** Reads all attributed cart events (newest cache is the source of truth). */
export async function readCartEvents(): Promise<CartEvent[]> {
  return [...(await load())];
}

/** Appends one attributed cart event and persists it (best-effort). */
export async function recordCartEvent(event: CartEvent): Promise<void> {
  if (!event.phone) return; // only attributed (signed-in) adds are tracked
  const events = await load();
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  cache = events;
  try {
    await ensureBucket();
    const body = Buffer.from(JSON.stringify(events), "utf-8");
    await supabaseAdmin.storage
      .from(BUCKET)
      .upload(PATH, body, { contentType: "application/json", upsert: true, cacheControl: "0" });
  } catch (err) {
    console.warn("cart event not persisted:", err instanceof Error ? err.message : err);
  }
}
