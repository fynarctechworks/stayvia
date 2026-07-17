import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tear the isolated E2E stack back down: kill the API process, stop the
// throwaway Postgres cluster. The .runtime dir is left on disk for post-run
// inspection (pg.log etc.) and is wiped by the NEXT run's setup.

const REPO = resolve(__dirname, "..");
const RUNTIME = join(REPO, "e2e", ".runtime");
const PGDATA = join(RUNTIME, "pgdata");
const PG_BIN = join(REPO, "apps", "web", "src-tauri", "resources", "pgsql", "bin");

export default async function globalTeardown(): Promise<void> {
  const pidsFile = join(RUNTIME, "pids.json");
  if (existsSync(pidsFile)) {
    try {
      const { api } = JSON.parse(readFileSync(pidsFile, "utf8")) as { api?: number };
      if (api) process.kill(api);
    } catch {
      /* already gone */
    }
  }
  const pgCtl = join(PG_BIN, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  if (existsSync(pgCtl) && existsSync(PGDATA)) {
    try {
      execFileSync(pgCtl, ["-D", PGDATA, "stop", "-m", "fast", "-t", "30"], { stdio: "pipe" });
    } catch {
      /* not running */
    }
  }
}
