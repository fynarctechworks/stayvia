import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { E2E_API_PORT, E2E_PG_PORT, E2E_WEB_PORT } from "../playwright.config";

// Shared constants + helpers for the cloud-mode e2e harness. Everything the
// suite touches is throwaway: a local Postgres cluster on an offset port, an
// API process with obviously-fake secrets, and a vite dev server. No live
// Supabase, no live Redis, no live Razorpay — ever.

const __dirname = dirname(fileURLToPath(import.meta.url));

export const REPO = resolve(__dirname, "..");
export const API_DIR = join(REPO, "apps", "api");
export const RUNTIME = join(REPO, "e2e", ".runtime");
export const PGDATA = join(RUNTIME, "pgdata");
export const PIDS_FILE = join(RUNTIME, "pids.json");
export const FIXTURES_FILE = join(RUNTIME, "fixtures.json");

export const PG_USER = "stayvia";
export const DATABASE_URL = `postgresql://${PG_USER}@127.0.0.1:${E2E_PG_PORT}/stayvia`;
export const API_URL = `http://127.0.0.1:${E2E_API_PORT}/api/v1`;
export const API_HEALTH_URL = `http://127.0.0.1:${E2E_API_PORT}/health`;

// Obviously-fake secrets, set explicitly by the harness. The real .env*
// files are never read (NODE_ENV=test loads .env.test*/.env, none of which
// exist — global-setup asserts that stays true).
export const E2E_JWT_SECRET = "e2e-fake-supabase-jwt-secret-0123456789";
export const E2E_WEBHOOK_SECRET = "e2e-fake-razorpay-webhook-secret";
export const E2E_SUPABASE_URL = "http://e2e-supabase.invalid";
export const E2E_SUPABASE_ANON_KEY = "e2e-fake-anon-key-not-a-real-secret";

// PostgreSQL 16 binaries for the throwaway cluster. STAYVIA_PG_BIN overrides
// (set it if your binaries live elsewhere); the default is the known local
// install at %LOCALAPPDATA%\PostgreSQL\pgsql\bin.
export function resolvePgBin(): string {
  if (process.env.STAYVIA_PG_BIN) return process.env.STAYVIA_PG_BIN;
  const localAppData = process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", ".local");
  return join(localAppData, "PostgreSQL", "pgsql", "bin");
}

export function pgTool(name: string): string {
  const exe = join(resolvePgBin(), process.platform === "win32" ? `${name}.exe` : name);
  if (!existsSync(exe)) {
    throw new Error(
      `${exe} not found — install PostgreSQL 16 binaries there or point STAYVIA_PG_BIN at a directory containing initdb/pg_ctl/createdb/psql.`,
    );
  }
  return exe;
}

// Env for every child the harness spawns against the throwaway stack (API,
// migration runner, seeder). Starts from process.env (PATH etc.), strips
// anything that could point at live infra, then sets explicit fakes. The
// API's layered dotenv loader can't reintroduce live values: NODE_ENV=test
// only reads .env.test.local/.env.test/.env and global-setup refuses to run
// if any of those exist.
export function apiChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(DATABASE_URL|SUPABASE_|UPSTASH_|RAZORPAY_|TWILIO_|RESEND_|ENCRYPTION_KEY|SEED_ADMIN_|OTP_|GOOGLE_REVIEW|FRONTEND_URL|TRIAL_DAYS|NODE_ENV|PORT|E2E_AUTH_SHIM)/.test(
        key,
      )
    ) {
      delete env[key];
    }
  }
  return Object.assign(env, {
    NODE_ENV: "test",
    E2E_AUTH_SHIM: "1",
    PORT: String(E2E_API_PORT),
    DATABASE_URL,
    SUPABASE_URL: E2E_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: "e2e-fake-service-role-key-not-a-real-secret",
    SUPABASE_JWT_SECRET: E2E_JWT_SECRET,
    ENCRYPTION_KEY: "ab".repeat(32),
    FRONTEND_URL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    NOTIFICATIONS_PROVIDER: "stub",
    RAZORPAY_WEBHOOK_SECRET: E2E_WEBHOOK_SECRET,
    // Make direct DB subscription flips visible immediately (billing suite).
    SUBSCRIPTION_CACHE_TTL_MS: "0",
    ...overrides,
  });
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Mint an HS256 JWT the API's E2E_AUTH_SHIM accepts — same claim shape
// GoTrue issues, signed with the harness's fake SUPABASE_JWT_SECRET.
export function mintToken(sub: string, email: string, opts: { expiresInSec?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(
    Buffer.from(
      JSON.stringify({
        sub,
        email,
        aud: "authenticated",
        role: "authenticated",
        aal: "aal1",
        amr: [{ method: "password", timestamp: now }],
        iat: now,
        exp: now + (opts.expiresInSec ?? 3600),
      }),
    ),
  );
  const sig = base64Url(
    createHmac("sha256", E2E_JWT_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

// Seeded-tenant fixture, written by e2e/seed.ts during global setup.
export interface HotelFixture {
  hotelName: string;
  propertyId: string;
  adminId: string;
  adminEmail: string;
  roomIds: string[];
  roomNumbers: string[];
  guestId: string;
  guestName: string;
  reservationId: string;
  reservationNumber: string;
  invoiceId: string;
  razorpaySubscriptionId: string;
}

export interface Fixtures {
  hotelA: HotelFixture;
  hotelB: HotelFixture;
}

export function loadFixtures(): Fixtures {
  return JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as Fixtures;
}

// One-shot SQL against the throwaway cluster (billing suite flips
// subscription rows directly). Opens and closes its own connection so a
// spec can't leak clients into the serial run.
export async function runSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}
