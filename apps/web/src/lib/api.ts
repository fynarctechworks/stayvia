import { UI_PREVIEW, mockGet, mockMutation } from "./mock-data";
import { supabase } from "./supabase";

const RAW_BASE = (import.meta.env.VITE_API_URL as string) ?? "";
const BASE = RAW_BASE.replace(/\/+$/, "");

// Exported for the few call sites that fetch binary responses (PDF receipts /
// previews) with a raw fetch() instead of the JSON helpers below — they must
// use the same Supabase session token selection.
export async function authHeader(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

// Helper for callers that want one idempotency key per UI intent. Use the
// returned function inside a React component (typically tied to a form or
// modal instance) and pass the resulting key to api.post on each submit.
// All clicks during the same intent share the same key; calling next()
// rotates it for the next intent.
export function newIdempotencyKey(): string {
  // crypto.randomUUID is available in all modern browsers and Node 14+.
  // Fall back to a Math.random-based key only if the runtime is ancient.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Tracks whether we've already started the sign-out cascade so concurrent
// in-flight requests that all return 401 don't each trigger a separate
// signOut() / page reload.
let signingOutFor401 = false;

async function handle401(): Promise<void> {
  if (signingOutFor401) return;
  signingOutFor401 = true;
  try {
    await supabase.auth.signOut();
  } catch {
    /* ignore — we're about to reload anyway */
  }
  // Avoid hard-redirect loop if user is already on /login.
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    const from = window.location.pathname + window.location.search;
    window.location.replace(`/login?expired=1&from=${encodeURIComponent(from)}`);
  }
}

// Fired when the API answers 402 SUBSCRIPTION_REQUIRED (trial over /
// subscription lapsed). AppShell listens and steers the user to /billing.
// The request itself still rejects with a normal ApiError so queries and
// mutations fail as usual.
export const SUBSCRIPTION_REQUIRED_EVENT = "stayvia:subscription-required";

function maybeSignalSubscriptionRequired(status: number, code: string | undefined): void {
  if (status === 402 && code === "SUBSCRIPTION_REQUIRED" && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SUBSCRIPTION_REQUIRED_EVENT));
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 304) {
    throw new ApiError(304, "NOT_MODIFIED", "Unexpected 304. Disable ETag on server");
  }
  // A 401 from the login endpoint is a CREDENTIALS failure, not an expired
  // session — let it fall through to the generic parse below so the server's
  // real message ("Email or password is incorrect") reaches the form, and
  // don't fire the sign-out/redirect cascade mid-login.
  const isAuthAttempt = /\/auth\/login(\?|$)/.test(res.url);
  if (res.status === 401 && !isAuthAttempt) {
    // Fire-and-forget the sign-out — we don't want every caller to await
    // it, but we still throw so the in-flight request short-circuits.
    void handle401();
    throw new ApiError(401, "UNAUTHENTICATED", "Session expired. Please sign in again.");
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { success?: boolean; data?: T; error?: { code?: string; message?: string; details?: unknown } }) : {};
  if (!res.ok || json?.success === false) {
    maybeSignalSubscriptionRequired(res.status, json?.error?.code);
    throw new ApiError(
      res.status,
      json?.error?.code ?? "UNKNOWN",
      json?.error?.message ?? `HTTP ${res.status}`,
      json?.error?.details,
    );
  }
  return json.data as T;
}

export const api = {
  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    if (UI_PREVIEW) return mockGet<T>(path, params);
    const url = new URL(`${BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, { headers: await authHeader() });
    return handle<T>(res);
  },

  async post<T>(
    path: string,
    body?: unknown,
    // When provided, sent as Idempotency-Key. Server-side middleware on
    // payment/credit endpoints replays the original response if the same
    // key arrives twice, preventing duplicate charges from double-click
    // or network retry.
    opts?: { idempotencyKey?: string },
  ): Promise<T> {
    if (UI_PREVIEW) return mockMutation<T>(path);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((await authHeader()) as Record<string, string>),
    };
    if (opts?.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return handle<T>(res);
  },

  async put<T>(path: string, body?: unknown): Promise<T> {
    if (UI_PREVIEW) return mockMutation<T>(path);
    const res = await fetch(`${BASE}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return handle<T>(res);
  },

  async patch<T>(path: string, body?: unknown): Promise<T> {
    if (UI_PREVIEW) return mockMutation<T>(path);
    const res = await fetch(`${BASE}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return handle<T>(res);
  },

  async del<T>(path: string): Promise<T> {
    if (UI_PREVIEW) return mockMutation<T>(path);
    const res = await fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: await authHeader(),
    });
    return handle<T>(res);
  },

  async upload<T>(path: string, form: FormData): Promise<T> {
    if (UI_PREVIEW) return mockMutation<T>(path);
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: await authHeader(),
      body: form,
    });
    return handle<T>(res);
  },
};

export async function getList<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<{ data: T[]; meta: { total: number; page: number; per_page: number } }> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: await authHeader() });
  if (res.status === 401) {
    void handle401();
    throw new ApiError(401, "UNAUTHENTICATED", "Session expired. Please sign in again.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    maybeSignalSubscriptionRequired(res.status, json?.error?.code);
    throw new ApiError(res.status, json?.error?.code ?? "UNKNOWN", json?.error?.message ?? `HTTP ${res.status}`);
  }
  return { data: json.data, meta: json.meta };
}
