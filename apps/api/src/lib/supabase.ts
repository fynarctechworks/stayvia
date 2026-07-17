import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

// Online: a real Supabase admin client (auth token verification + storage).
// Offline desktop: SUPABASE_* is absent — auth verifies locally (see
// middleware/auth.ts) and storage is local-FS (see lib/storage.ts), so nothing
// should touch this client. We expose it as possibly-null and guard the few
// remaining call sites; accessing it in offline mode is a bug we want to fail
// loudly rather than silently hit a dead cloud.
export const supabaseEnabled = !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

let client: SupabaseClient | null = null;
if (supabaseEnabled) {
  client = createClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * The Supabase admin client. Throws if accessed in offline mode, where no
 * cloud client exists — callers in offline paths must branch before reaching
 * here. Kept as a function so the throw happens at use, not at import.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    throw new Error(
      "Supabase admin client is unavailable in offline mode — this code path should not run offline",
    );
  }
  return client;
}

// Back-compat proxy: existing call sites do `supabaseAdmin.auth.getUser(...)`
// / `supabaseAdmin.storage.from(...)`. Proxy to the real client, throwing in
// offline mode on first property access.
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getSupabaseAdmin() as object, prop, receiver);
  },
});
