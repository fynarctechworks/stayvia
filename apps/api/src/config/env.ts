import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

import { applyHandshake } from "./handshake.js";

// Offline desktop sidecar: read the stdin handshake (DATABASE_URL + secrets)
// into process.env BEFORE we resolve env files or validate. No-op unless the
// Tauri shell set SLDT_HANDSHAKE_STDIN=1.
applyHandshake();

// Env-file resolution. dotenv has no built-in "mode" concept, so we layer
// it ourselves to mirror Vite's behaviour on the web side:
//
//   1. .env.<NODE_ENV>.local  — machine-specific overrides (gitignored)
//   2. .env.<NODE_ENV>        — the per-environment file (gitignored)
//   3. .env                   — shared fallback / legacy single file
//
// Earlier files win because dotenv never overwrites an already-set key.
// Real process env (set by the hosting platform) always wins over all of
// them — so production secrets injected by the host are never clobbered
// by a stray committed file.
//
// NODE_ENV is read straight from process.env here (it's set before the
// app boots, e.g. `NODE_ENV=production node dist/index.js`). Defaults to
// 'development' for local `npm run dev`.
const nodeEnv = process.env.NODE_ENV ?? "development";

// Resolve apps/api root regardless of how the app is launched. tsx
// transpiles to CommonJS (no import.meta.dirname), the compiled build
// runs as ESM, and the cwd differs between `npm run dev` (apps/api) and
// the Docker CMD (/app). So instead of trusting one anchor, we walk up
// from the cwd looking for the directory that owns the API package.json.
function findApiRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    // The compiled API lives in apps/api/dist; dev runs from apps/api.
    // Either way, apps/api/package.json is the marker we want.
    if (existsSync(resolve(dir, "package.json"))) {
      try {
        const pkg = JSON.parse(
          readFileSync(resolve(dir, "package.json"), "utf8"),
        ) as { name?: string };
        if (pkg.name === "@hoteldesk/api") return dir;
      } catch {
        // ignore unreadable package.json, keep walking
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallbacks: cwd itself, then cwd/apps/api (monorepo-root launch).
  if (existsSync(resolve(process.cwd(), "apps", "api"))) {
    return resolve(process.cwd(), "apps", "api");
  }
  return process.cwd();
}

const apiRoot = findApiRoot();
for (const file of [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, ".env"]) {
  const path = resolve(apiRoot, file);
  if (existsSync(path)) dotenv.config({ path });
}

// Offline desktop mode. When set (by the Tauri sidecar handshake, or manually
// for local testing), the app runs fully against embedded Postgres with NO
// cloud dependencies: Supabase (auth/storage) and Upstash (Redis) become
// optional. Auth falls back to local JWT verification, storage to the local
// filesystem, and caching to an in-process store. WhatsApp/OTP delivery still
// needs internet but queues offline.
const OFFLINE = process.env.OFFLINE_MODE === "1" || process.env.OFFLINE_MODE === "true";

// In offline mode, a cloud var that's absent is fine (optional). Online, it's
// required exactly as before — no behavioural change for server/Docker.
const cloudString = (min: number) =>
  OFFLINE ? z.string().min(min).optional() : z.string().min(min);
const cloudUrl = () => (OFFLINE ? z.string().url().optional() : z.string().url());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test", "local"]).default("development"),
  PORT: z.coerce.number().default(3000),

  // Offline flags surfaced on `env` so the rest of the app can branch on them.
  OFFLINE_MODE: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  // True on first launch of a fresh cluster: the sidecar must build the schema
  // (drizzle push + migrate) before serving. Set by the handshake.
  SLDT_SCHEMA_BOOTSTRAP: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),

  DATABASE_URL: z.string().url(),
  SUPABASE_URL: cloudUrl(),
  SUPABASE_SERVICE_ROLE_KEY: cloudString(20),
  SUPABASE_JWT_SECRET: cloudString(20),

  UPSTASH_REDIS_REST_URL: cloudUrl(),
  UPSTASH_REDIS_REST_TOKEN: cloudString(10),
  UPSTASH_REDIS_URL: cloudString(10),

  // Local session-signing secret used by offline auth (Task 3). Required in
  // offline mode, ignored online (Supabase mints tokens there).
  LOCAL_JWT_SECRET: OFFLINE ? z.string().min(20) : z.string().min(20).optional(),

  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "ENCRYPTION_KEY must be 64-char hex (32 bytes)"),

  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  SEED_ADMIN_EMAIL: z.string().email().default("admin@hoteldesk.local"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe123!"),
  SEED_ADMIN_NAME: z.string().default("Hotel Owner"),

  NOTIFICATIONS_PROVIDER: z.enum(["stub", "live"]).default("stub"),
  HOTEL_DISPLAY_NAME: z.string().default("SLDT Stay Inn"),

  TWILIO_ACCOUNT_SID: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  TWILIO_AUTH_TOKEN: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  TWILIO_WHATSAPP_FROM: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional().transform((v) => (v === "" ? undefined : v)),

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  // Phase 3 — feature-flagged integrations. All optional; the modules
  // detect missing keys and degrade gracefully.
  RAZORPAY_KEY_ID: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  RAZORPAY_KEY_SECRET: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  RESEND_API_KEY: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  RESEND_FROM: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  // Google review link the post-checkout WhatsApp deep-links to. When
  // absent, the review-prompt template is sent without a link.
  GOOGLE_REVIEW_URL: z.string().url().optional().transform((v) => (v === "" ? undefined : v)),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
