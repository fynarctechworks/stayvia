// Offline desktop mode detection + local session store.
//
// The web bundle runs in two contexts:
//   - Browser (online): auth via Supabase, token from supabase.auth.
//   - Tauri desktop (offline): auth via the local sidecar's /auth/login (PIN),
//     token is a local JWT we hold here.
//
// We detect the desktop context by the presence of the Tauri global, and treat
// that as "offline mode" for the auth/transport layer. The API base URL points
// at the local sidecar in that case (VITE_API_URL is baked to the loopback
// sidecar for desktop builds).

const LOCAL_TOKEN_KEY = "sldt.local.token";
const LOCAL_REFRESH_KEY = "sldt.local.refresh";

// Tauri v2 exposes window.__TAURI_INTERNALS__ (and __TAURI__ with withGlobalTauri).
// Either presence means we're in the desktop shell.
export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}

// Offline mode = desktop shell. (Kept as its own function so we can later add a
// runtime "is the sidecar reachable" probe if we ever run the desktop shell
// against a cloud API.)
export function isOfflineMode(): boolean {
  return isDesktop();
}

// --- Local session token store (desktop only) -----------------------------

let accessToken: string | null =
  typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_TOKEN_KEY) : null;
let refreshToken: string | null =
  typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_REFRESH_KEY) : null;

export function getLocalToken(): string | null {
  return accessToken;
}

export function getLocalRefreshToken(): string | null {
  return refreshToken;
}

export function setLocalSession(token: string, refresh: string): void {
  accessToken = token;
  refreshToken = refresh;
  try {
    localStorage.setItem(LOCAL_TOKEN_KEY, token);
    localStorage.setItem(LOCAL_REFRESH_KEY, refresh);
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

export function clearLocalSession(): void {
  accessToken = null;
  refreshToken = null;
  try {
    localStorage.removeItem(LOCAL_TOKEN_KEY);
    localStorage.removeItem(LOCAL_REFRESH_KEY);
  } catch {
    /* ignore */
  }
}
