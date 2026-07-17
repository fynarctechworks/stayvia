import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGDATA, PIDS_FILE, resolvePgBin } from "./harness";

// Tear the isolated E2E stack back down: kill the API process, stop the
// throwaway Postgres cluster. The .runtime dir is left on disk for post-run
// inspection (pg.log, api.log, fixtures.json) and is wiped by the NEXT
// run's setup.

export default async function globalTeardown(): Promise<void> {
  if (existsSync(PIDS_FILE)) {
    try {
      const { api } = JSON.parse(readFileSync(PIDS_FILE, "utf8")) as { api?: number };
      if (api) process.kill(api);
    } catch {
      /* already gone */
    }
  }
  const pgCtl = join(
    resolvePgBin(),
    process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl",
  );
  if (existsSync(pgCtl) && existsSync(PGDATA)) {
    try {
      execFileSync(pgCtl, ["-D", PGDATA, "stop", "-m", "fast", "-t", "30"], { stdio: "pipe" });
    } catch {
      /* not running */
    }
  }
}
