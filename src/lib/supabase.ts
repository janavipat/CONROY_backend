import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

/**
 * Admin client — uses the service-role key and BYPASSES Row Level Security.
 * Server-side only. This is the gatekeeper for writes (orders, contacts, …).
 */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Anonymous client — uses the public anon key and RESPECTS RLS. Used for
 * auth flows (sign-up / sign-in) where we act on behalf of the end user.
 */
export const supabaseAnon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
