import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

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
        if (pkg.name === "@stayvia/api") return dir;
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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test", "local"]).default("development"),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_JWT_SECRET: z.string().min(20),

  // Upstash Redis is optional by design: when absent, lib/redis.ts degrades to
  // an in-process TTL cache with no pub/sub fan-out.
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(10).optional(),
  UPSTASH_REDIS_URL: z.string().min(10).optional(),

  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "ENCRYPTION_KEY must be 64-char hex (32 bytes)"),

  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  SEED_ADMIN_EMAIL: z.string().email().default("admin@stayvia.local"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe123!"),
  SEED_ADMIN_NAME: z.string().default("Hotel Owner"),

  NOTIFICATIONS_PROVIDER: z.enum(["stub", "live"]).default("stub"),
  HOTEL_DISPLAY_NAME: z.string().default("Stayvia"),

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
  RAZORPAY_PLAN_ID: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  // Free-trial length granted at signup. Seed + public signup both read this.
  TRIAL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
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
