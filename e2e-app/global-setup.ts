import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_CDP_PORT } from "../playwright-app.config";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Launches the REAL Windows app (Tauri shell + embedded Postgres + api.exe
// sidecar) as a throwaway desk:
//
//   LOCALAPPDATA → e2e-app/.runtime/localappdata
//
// so every anchor the app knows (SLDT config, secrets, pgdata, storage) is
// created fresh inside the runtime folder and torn down afterwards.
//
// SAFETY GUARD: the app's Postgres (5433) and sidecar (3010) ports are fixed.
// If either is in use — i.e. the real desk app is running — this suite ABORTS
// immediately. It never kills, never reuses, never touches the live desk.

const REPO = resolve(__dirname, "..");
const RUNTIME = join(REPO, "e2e-app", ".runtime");
const FAKE_LOCALAPPDATA = join(RUNTIME, "localappdata");
const PIDS = join(RUNTIME, "pids.json");

const APP_EXE =
  process.env.APP_EXE ?? join(REPO, "apps", "web", "src-tauri", "target", "release", "app.exe");

const REAL_DESK_PORTS = [5433, 3010];

function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const sock = createConnection({ host: "127.0.0.1", port, timeout: 1500 });
    sock.once("connect", () => {
      sock.destroy();
      done(true);
    });
    sock.once("error", () => done(false));
    sock.once("timeout", () => {
      sock.destroy();
      done(false);
    });
  });
}

async function waitHttp(url: string, timeoutMs: number, label: string): Promise<void> {
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
  throw new Error(`${label} not ready in ${timeoutMs}ms (${lastErr})`);
}

export default async function globalSetup(): Promise<void> {
  // ---- safety guard -------------------------------------------------------
  for (const port of REAL_DESK_PORTS) {
    if (await portInUse(port)) {
      throw new Error(
        `Port ${port} is in use — the real SLDT Stay Inn app (or its database) ` +
          `appears to be running. Close the desk app completely, then re-run ` +
          `"npm run test:e2e:app". This suite never touches a live desk.`,
      );
    }
  }
  if (!existsSync(APP_EXE)) {
    throw new Error(`App binary not found: ${APP_EXE} (build it or set APP_EXE).`);
  }

  console.log("[e2e-app] ports clear — launching throwaway desk…");
  rmSync(RUNTIME, { recursive: true, force: true });
  mkdirSync(FAKE_LOCALAPPDATA, { recursive: true });

  // ---- launch the real app ------------------------------------------------
  const app = spawn(APP_EXE, [], {
    env: {
      ...process.env,
      // Fresh anchor: config.json, secrets, pgdata, storage all land here.
      LOCALAPPDATA: FAKE_LOCALAPPDATA,
      // Expose WebView2's Chromium DevTools endpoint for Playwright.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${APP_CDP_PORT}`,
    },
    stdio: "ignore",
    detached: true,
  });
  writeFileSync(PIDS, JSON.stringify({ app: app.pid }));
  app.unref();

  // First boot initdb's a fresh cluster + bootstraps the schema — allow time.
  console.log("[e2e-app] waiting for sidecar health (first boot initializes a fresh DB)…");
  await waitHttp("http://127.0.0.1:3010/health", 120_000, "app sidecar");
  console.log("[e2e-app] waiting for WebView2 CDP…");
  await waitHttp(`http://127.0.0.1:${APP_CDP_PORT}/json/version`, 60_000, "WebView2 CDP");
  console.log("[e2e-app] app ready");
}
