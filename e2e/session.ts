import type { Page } from "@playwright/test";

import { mintToken } from "./harness";

// Browser-side auth for e2e: instead of a real GoTrue login (no live
// Supabase in this harness), seed the exact localStorage entry supabase-js
// persists sessions under (storageKey "stayvia.session" — see
// apps/web/src/lib/supabase.ts) with a fabricated session wrapping a minted
// HS256 token the API's E2E_AUTH_SHIM accepts. supabase-js only requires
// access_token/refresh_token/expires_at to treat a stored session as valid,
// and its MFA assurance check decodes the JWT locally, so no network call
// to the (fake) Supabase URL ever happens.
export async function injectSession(
  page: Page,
  user: { id: string; email: string },
): Promise<void> {
  const token = mintToken(user.id, user.email);
  const session = {
    access_token: token,
    refresh_token: "e2e-refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
  // Navigate once to establish the app origin, plant the session, then let
  // the caller navigate to the page under test (full reload re-reads it).
  await page.goto("/login");
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    ["stayvia.session", JSON.stringify(session)] as [string, string],
  );
}
