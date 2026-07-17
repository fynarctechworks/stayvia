import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { E2E_API_PORT, E2E_PG_PORT } from "../playwright.config";
import {
  API_DIR,
  API_HEALTH_URL,
  DATABASE_URL,
  PGDATA,
  PG_USER,
  PIDS_FILE,
  REPO,
  RUNTIME,
  apiChildEnv,
  pgTool,
} from "./harness";

// Boots a fully ISOLATED cloud-mode Stayvia stack for the E2E suite:
//
//   e2e/.runtime/pgdata   — throwaway local Postgres 16 cluster (port 5434)
//   apps/api (tsx)        — the real API, NODE_ENV=test + E2E_AUTH_SHIM=1,
//                           port 3020, obviously-fake secrets
//   e2e/.runtime/fixtures.json — ids of the two seeded tenants
//
// The cluster is initdb'd fresh every run: migrations applied via the real
// runner (scripts/migrate.mjs — 127.0.0.1 passes its non-local-host guard),
// then two hotels seeded through lib/provisionProperty. Nothing touches live
// Supabase/Redis/Razorpay: the harness sets every secret itself and the
// suite refuses to run if an apps/api/.env(.test*) file could leak real
// values into the NODE_ENV=test loader.

const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

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
  const stage = (msg: string) => console.log(`[e2e-setup] ${msg}`);

  if (!existsSync(TSX_CLI)) {
    throw new Error(`${TSX_CLI} missing — run npm install first.`);
  }
  // The API's layered env loader under NODE_ENV=test reads .env.test.local,
  // .env.test and .env from apps/api. None of these exist in this repo; if
  // one appears it could inject real infra into the test API — refuse.
  for (const file of [".env.test.local", ".env.test", ".env"]) {
    if (existsSync(join(API_DIR, file))) {
      throw new Error(
        `apps/api/${file} exists — it would be loaded by the NODE_ENV=test API and could point the e2e stack at live infrastructure. Remove or rename it before running the suite.`,
      );
    }
  }

  // Fresh runtime every run.
  rmSync(RUNTIME, { recursive: true, force: true });
  mkdirSync(RUNTIME, { recursive: true });

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
        ["-h", "127.0.0.1", "-p", String(E2E_PG_PORT), "-U", PG_USER, "stayvia"],
        { stdio: "pipe" },
      );
      break;
    } catch (e) {
      const msg =
        e instanceof Error && "stderr" in e ? String((e as { stderr?: Buffer }).stderr ?? e) : String(e);
      if (msg.includes("already exists")) break;
      if (Date.now() > deadline) throw new Error(`createdb failed after retries: ${msg}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // 2. Schema via the real migration runner. DATABASE_URL is set in the
  //    child env, which wins over any dotenv file, and 127.0.0.1 passes the
  //    runner's guard-db-target check.
  stage("applying migrations…");
  execFileSync(process.execPath, [join(API_DIR, "scripts", "migrate.mjs")], {
    cwd: API_DIR,
    env: apiChildEnv(),
    stdio: "pipe",
  });

  // 3. Seed the two tenants + fixture ids. `node --import tsx` (not the tsx
  //    CLI, which re-spawns a child process) so the seeder — which imports
  //    the API's TS sources directly — runs in a single killable process.
  stage("seeding tenants…");
  execFileSync(process.execPath, ["--import", "tsx", join(REPO, "e2e", "seed.ts")], {
    cwd: API_DIR,
    env: apiChildEnv(),
    stdio: "pipe",
  });

  // 4. The real API against the throwaway cluster, run from TS via
  //    `node --import tsx` (single process — the teardown's process.kill
  //    must hit the server itself, not a tsx wrapper). Output goes to a
  //    FILE (not pipes tied to this short-lived setup process) so a
  //    mid-suite crash is diagnosable and the child can't be killed by its
  //    pipes going away. Detached: it must outlive the setup process and
  //    keep serving for the whole suite.
  stage("starting API…");
  const apiLogFd = openSync(join(RUNTIME, "api.log"), "a");
  const api = spawn(process.execPath, ["--import", "tsx", join(API_DIR, "src", "index.ts")], {
    cwd: API_DIR,
    env: apiChildEnv(),
    stdio: ["ignore", apiLogFd, apiLogFd],
    detached: true,
  });
  writeFileSync(PIDS_FILE, JSON.stringify({ api: api.pid }));

  const apiLog = () => {
    try {
      return readFileSync(join(RUNTIME, "api.log"), "utf8").slice(-4000);
    } catch {
      return "(no api.log)";
    }
  };

  stage("waiting for API health…");
  try {
    await waitFor(API_HEALTH_URL, 60_000, "E2E API");
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : e}\nAPI log:\n${apiLog()}`);
  }
  stage(`stack ready (pg :${E2E_PG_PORT}, api :${E2E_API_PORT}, db ${DATABASE_URL})`);
  api.unref();
}
