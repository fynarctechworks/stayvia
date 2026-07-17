import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const RUNTIME = join(REPO, "e2e-app", ".runtime");
const PG_BIN = join(REPO, "apps", "web", "src-tauri", "resources", "pgsql", "bin");

// Stop the throwaway desk: kill the app's process tree (taskkill /T also
// reaps api.exe and any Chromium children), then stop the app's embedded
// Postgres — a force-kill skips the app's own graceful CloseRequested stop.
export default async function globalTeardown(): Promise<void> {
  const pidsFile = join(RUNTIME, "pids.json");
  if (existsSync(pidsFile)) {
    try {
      const { app } = JSON.parse(readFileSync(pidsFile, "utf8")) as { app?: number };
      if (app && process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(app), "/T", "/F"], { stdio: "pipe" });
      } else if (app) {
        process.kill(app);
      }
    } catch {
      /* already gone */
    }
  }
  const pgdata = join(RUNTIME, "localappdata", "SLDT", "pgdata");
  const pgCtl = join(PG_BIN, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  if (existsSync(pgCtl) && existsSync(pgdata)) {
    try {
      execFileSync(pgCtl, ["-D", pgdata, "stop", "-m", "fast", "-t", "30"], { stdio: "ignore" });
    } catch {
      /* not running */
    }
  }
}
