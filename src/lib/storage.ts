import { supabaseAdmin } from "./supabase.js";

/**
 * Image handling — files are uploaded to **Supabase Storage** (object storage),
 * NOT the database. Only the resulting public URL is stored in product_images.
 * This keeps the database small and fast even for large images.
 */
export const PRODUCT_BUCKET = "product-images";

let bucketReady = false;

/** Ensures the public storage bucket exists (idempotent). */
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { data } = await supabaseAdmin.storage.getBucket(PRODUCT_BUCKET);
  if (!data) {
    await supabaseAdmin.storage.createBucket(PRODUCT_BUCKET, {
      public: true,
      fileSizeLimit: "10MB",
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/avif"],
    });
  }
  bucketReady = true;
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-60);
}

export interface UploadResult {
  url: string;
  path: string;
}

/** Uploads an image buffer to storage and returns its public URL. */
export async function uploadProductImage(
  buffer: Buffer,
  originalName: string,
  contentType: string,
  seed: number,
): Promise<UploadResult> {
  await ensureBucket();

  const ext = (originalName.split(".").pop() || "jpg").toLowerCase();
  const safe = slugifyName(originalName.replace(/\.[^.]+$/, "")) || "image";
  // Caller-supplied seed keeps names unique without Date.now() (which is blocked).
  const path = `products/${seed}-${safe}.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(PRODUCT_BUCKET)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(error.message);

  const { data } = supabaseAdmin.storage.from(PRODUCT_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, path };
}
