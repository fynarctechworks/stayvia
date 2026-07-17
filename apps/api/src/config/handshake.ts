import { readFileSync } from "node:fs";

// Offline desktop handshake.
//
// When the Tauri shell launches this API as a sidecar (see
// apps/web/src-tauri/src/sidecar.rs), it sets SLDT_HANDSHAKE_STDIN=1 and
// writes ONE line of JSON to our stdin BEFORE anything else:
//
//   {"database_url":"postgresql://…","schema_bootstrap":true,"port":3010}
//
// We read it synchronously here and fold the values into process.env so the
// normal env loader (config/env.ts) picks them up. Secrets arrive over stdin
// rather than argv/env because on Windows any process can read another's
// command line, and inheritable env vars leak to grandchildren (Chromium).
//
// This runs at import time, before env.ts validates, and is a no-op unless
// SLDT_HANDSHAKE_STDIN is set — so normal server/dev/Docker boots are
// unaffected.

export type Handshake = {
  database_url: string;
  schema_bootstrap: boolean;
  port: number;
  // Task 3 will add: local_jwt_secret, encryption_key. Optional for now.
  local_jwt_secret?: string;
  encryption_key?: string;
};

let cached: Handshake | null = null;

/**
 * True when we're running as the offline desktop sidecar.
 */
export function isOfflineSidecar(): boolean {
  return process.env.SLDT_HANDSHAKE_STDIN === "1";
}

/**
 * Read and apply the stdin handshake. Idempotent. Blocks briefly on fd 0.
 * Call this once, first thing in the process, before importing env.ts.
 */
export function applyHandshake(): Handshake | null {
  if (!isOfflineSidecar()) return null;
  if (cached) return cached;

  let raw: string;
  try {
    // fd 0 is stdin. The sidecar writes exactly one line then closes its
    // write end, so a full synchronous read returns the whole payload.
    raw = readFileSync(0, "utf8");
  } catch (err) {
    console.error("[handshake] failed to read stdin:", err);
    process.exit(1);
  }

  const line = raw.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) {
    console.error("[handshake] SLDT_HANDSHAKE_STDIN set but no JSON on stdin");
    process.exit(1);
  }

  let parsed: Handshake;
  try {
    parsed = JSON.parse(line) as Handshake;
  } catch (err) {
    console.error("[handshake] invalid JSON on stdin:", err);
    process.exit(1);
  }

  // Fold into process.env so env.ts validation and the rest of the app see
  // them. We never overwrite an already-set value (a real env var wins), so
  // tests can inject their own.
  const set = (k: string, v: string | undefined) => {
    if (v !== undefined && process.env[k] === undefined) process.env[k] = v;
  };
  set("DATABASE_URL", parsed.database_url);
  set("PORT", String(parsed.port));
  set("LOCAL_JWT_SECRET", parsed.local_jwt_secret);
  set("ENCRYPTION_KEY", parsed.encryption_key);
  // The sidecar handshake implies offline mode.
  set("OFFLINE_MODE", "1");
  if (parsed.schema_bootstrap) set("SLDT_SCHEMA_BOOTSTRAP", "1");

  loadDeskMessagingEnv(set);

  cached = parsed;
  return parsed;
}

// Optional operator-provided delivery credentials for the offline desk:
// %LOCALAPPDATA%\SLDT\messaging.env, dotenv-style KEY=VALUE lines. This is
// what lets the desk actually SEND its queued WhatsApp/email when it has
// internet — the outbox deliverer uses the same Twilio/Resend clients as the
// cloud API. Whitelisted keys only, and a real env var always wins, so the
// file can't override core config like DATABASE_URL.
const DESK_ENV_KEYS = new Set([
  "NOTIFICATIONS_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "TWILIO_MESSAGING_SERVICE_SID",
  "RESEND_API_KEY",
  "RESEND_FROM",
  // Lets the drainer mirror local files (invoice/receipt PDFs) to the public
  // cloud bucket so guest-facing links in queued messages actually resolve.
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  // Phase-2 cloud-backup sync provisioning (same operator file, one place).
  "SYNC_INGEST_URL",
  "SYNC_DEVICE_ID",
  "SYNC_DEVICE_TOKEN",
]);

function loadDeskMessagingEnv(set: (k: string, v: string | undefined) => void): void {
  const base = process.env.LOCALAPPDATA;
  if (!base) return;
  let raw: string;
  try {
    raw = readFileSync(`${base}\\SLDT\\messaging.env`, "utf8");
  } catch {
    return; // file is optional
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!DESK_ENV_KEYS.has(key)) continue;
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    set(key, value);
  }
  console.error("[handshake] loaded desk messaging.env");
}
