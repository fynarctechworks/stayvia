import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

// Supabase admin client (auth token verification + storage). SUPABASE_* env
// vars are required, so the client always exists.
export const supabaseAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { autoRefreshToken: false, persistSession: false },
  },
);

// Password checks MUST use this, never `supabaseAdmin`.
//
// supabase-js retains the signed-in session in memory even with
// persistSession:false, and its storage client derives its Authorization
// header from that session. Calling signInWithPassword on the shared admin
// client therefore made every subsequent Storage call in the process run as
// whichever user logged in last — across every tenant — instead of as the
// service role. That silently broke KYC uploads (403 under stock storage RLS),
// or, if someone "fixed" it with permissive `authenticated` policies, made the
// storage tenant boundary depend on who logged in most recently. With
// autoRefreshToken:false the captured session also expired after an hour,
// so storage started 401ing until the next login.
//
// A fresh client per check keeps the shared client's credentials untouched;
// the throwaway is garbage-collected once the check returns.
export function createCredentialCheckClient(): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
