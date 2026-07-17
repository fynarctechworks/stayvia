import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { E2E_API_PORT, E2E_PG_PORT, E2E_WEB_PORT } from "../playwright.config";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Boots a fully ISOLATED HotelDesk stack for the E2E suite:
//
//   e2e/.runtime/pgdata    — throwaway embedded-Postgres cluster (port 5434)
//   e2e/.runtime/storage   — throwaway file storage (KYC/PDFs)
//   apps/api/dist          — the real API, OFFLINE_MODE, port 3020
//
// The cluster is initdb'd fresh on every run and torn down afterwards, so
// tests are deterministic and can never read or write the live desk data
// (D:\SLDT / %LOCALAPPDATA%\SLDT). The API bootstraps its own schema
// (SLDT_SCHEMA_BOOTSTRAP=1) and seeds the first-run admin
// (admin@hoteldesk.local / PIN 424242) exactly like a fresh desk install.

const REPO = resolve(__dirname, "..");
const RUNTIME = join(REPO, "e2e", ".runtime");
const PGDATA = join(RUNTIME, "pgdata");
const STORAGE = join(RUNTIME, "storage");
const PG_BIN = join(REPO, "apps", "web", "src-tauri", "resources", "pgsql", "bin");
const API_DIST = join(REPO, "apps", "api", "dist", "index.js");
const PIDS = join(RUNTIME, "pids.json");

const PG_USER = "hoteldesk";
const DATABASE_URL = `postgresql://${PG_USER}@127.0.0.1:${E2E_PG_PORT}/hoteldesk`;

function pgTool(name: string): string {
  const exe = join(PG_BIN, process.platform === "win32" ? `${name}.exe` : name);
  if (!existsSync(exe)) {
    throw new Error(
      `${exe} not found — the bundled PostgreSQL binaries are required for E2E ` +
        `(see apps/web/src-tauri/resources/pgsql).`,
    );
  }
  return exe;
}

async function waitFor(url: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready in ${timeoutMs}ms (${lastErr})`);
}

export default async function globalSetup(): Promise<void> {
  if (!existsSync(API_DIST)) {
    throw new Error(
      `apps/api/dist/index.js missing — run "npm run build:api" once before the E2E suite.`,
    );
  }

  // Fresh runtime every run.
  rmSync(RUNTIME, { recursive: true, force: true });
  mkdirSync(STORAGE, { recursive: true });

  const stage = (msg: string) => {
    // Playwright is silent during globalSetup — log stages to the console AND
    // a file so a hang is diagnosable instead of a mystery.
    console.log(`[e2e-setup] ${msg}`);
  };

  // 1. Throwaway Postgres cluster. Loopback + trust auth is fine for a test
  //    cluster that lives for one suite run and holds only fixture data.
  stage("initdb…");
  execFileSync(pgTool("initdb"), ["-D", PGDATA, "-U", PG_USER, "--auth=trust", "-E", "UTF8"], {
    stdio: "pipe",
  });
  stage(`starting postgres on :${E2E_PG_PORT}…`);
  // stdio MUST be ignored here: pg_ctl hands its stdout/stderr to the
  // postmaster it spawns, and piped handles then never close — execFileSync
  // would wait on them forever even though pg_ctl itself exited (-w already
  // confirmed startup). Errors land in pg.log via -l.
  execFileSync(
    pgTool("pg_ctl"),
    ["-D", PGDATA, "-o", `-p ${E2E_PG_PORT}`, "-l", join(RUNTIME, "pg.log"), "start", "-w", "-t", "60"],
    { stdio: "ignore" },
  );
  // pg_ctl -w returns when the postmaster is up, but the first client connect
  // can still race it on Windows — retry createdb until the socket accepts.
  stage("creating database…");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      execFileSync(
        pgTool("createdb"),
        ["-h", "127.0.0.1", "-p", String(E2E_PG_PORT), "-U", PG_USER, "hoteldesk"],
        { stdio: "pipe" },
      );
      break;
    } catch (e) {
      const msg = e instanceof Error && "stderr" in e ? String((e as { stderr?: Buffer }).stderr ?? e) : String(e);
      if (msg.includes("already exists")) break;
      if (Date.now() > deadline) throw new Error(`createdb failed after retries: ${msg}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // 2. The real API in offline mode against the throwaway cluster. Its
  //    output goes to a FILE (not pipes tied to this short-lived setup
  //    process) so a mid-suite crash is diagnosable and the child can't be
  //    killed by its pipes going away. Detached: the child must outlive the
  //    setup process and keep serving for the whole suite.
  stage("starting API…");
  const apiLogFd = openSync(join(RUNTIME, "api.log"), "a");
  const api = spawn(process.execPath, [API_DIST], {
    cwd: join(REPO, "apps", "api"),
    env: {
      ...process.env,
      NODE_ENV: "production",
      OFFLINE_MODE: "1",
      SLDT_SCHEMA_BOOTSTRAP: "1",
      DATABASE_URL,
      PORT: String(E2E_API_PORT),
      LOCAL_JWT_SECRET: "e2e-".padEnd(64, "x"),
      ENCRYPTION_KEY: "ab".repeat(32),
      SLDT_STORAGE_DIR: STORAGE,
      NOTIFICATIONS_PROVIDER: "stub",
      // CORS: the API only trusts FRONTEND_URL + the Tauri origins; the test
      // vite server lives on its own port and must be allowed explicitly.
      FRONTEND_URL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    },
    stdio: ["ignore", apiLogFd, apiLogFd],
    detached: true,
  });
  const apiLog = () => {
    try {
      return readFileSync(join(RUNTIME, "api.log"), "utf8").slice(-4000);
    } catch {
      return "(no api.log)";
    }
  };

  writeFileSync(PIDS, JSON.stringify({ api: api.pid }));

  stage("waiting for API health…");
  try {
    await waitFor(`http://127.0.0.1:${E2E_API_PORT}/health`, 60_000, "E2E API");
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : e}\nAPI log:\n${apiLog()}`);
  }

  // /health answers before the first-run bootstrap (schema + admin seed)
  // finishes, so also wait until the seeded admin credential exists. Checked
  // via psql, NOT /auth/login — the login endpoint is rate-limited to 5
  // requests per window and the suite needs those for the real login tests.
  stage("waiting for first-run seed…");
  const seedDeadline = Date.now() + 60_000;
  for (;;) {
    try {
      const out = execFileSync(
        pgTool("psql"),
        [
          "-h", "127.0.0.1", "-p", String(E2E_PG_PORT), "-U", PG_USER, "-d", "hoteldesk",
          "-tAc", "SELECT count(*) FROM local_credentials",
        ],
        { stdio: "pipe" },
      )
        .toString()
        .trim();
      if (Number(out) > 0) break;
    } catch {
      /* table not created yet */
    }
    if (Date.now() > seedDeadline) {
      throw new Error(`first-run seed did not complete in time.\nAPI log:\n${apiLog()}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stage("stack ready");
  api.unref();
}
