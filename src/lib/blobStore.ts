import { supabaseAdmin } from "./supabase.js";

/**
 * Tiny JSON-in-Storage helper (no DB migration needed). Each store persists one
 * JSON file in the private `app-config` bucket and keeps an in-memory cache as
 * the source of truth, so reads always reflect the most recent write (Storage's
 * CDN can otherwise serve stale reads just after an upload).
 */
const BUCKET = "app-config";

let bucketReady = false;
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (!data) await supabaseAdmin.storage.createBucket(BUCKET, { public: false });
  bucketReady = true;
}

export function jsonStore<T>(path: string, fallback: T) {
  let cache: T | null = null;

  async function load(): Promise<T> {
    if (cache !== null) return cache;
    try {
      await ensureBucket();
      const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);
      if (error || !data) {
        cache = fallback;
      } else {
        const text = Buffer.from(await data.arrayBuffer()).toString("utf-8");
        const parsed = JSON.parse(text) as T;
        cache = parsed ?? fallback;
      }
    } catch {
      cache = fallback;
    }
    return cache;
  }

  return {
    /** Returns a deep copy so callers can mutate freely. */
    async read(): Promise<T> {
      return JSON.parse(JSON.stringify(await load())) as T;
    },
    /** Replaces the stored value (updates cache immediately, persists to storage). */
    async write(next: T): Promise<void> {
      cache = next;
      await ensureBucket();
      const body = Buffer.from(JSON.stringify(next), "utf-8");
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, body, { contentType: "application/json", upsert: true, cacheControl: "0" });
      if (error) throw new Error(error.message);
    },
  };
}
