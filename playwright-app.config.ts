import { defineConfig } from "@playwright/test";

// Native Windows-app E2E: drives the REAL Tauri executable (app.exe) through
// WebView2's Chromium DevTools Protocol. Run with:
//
//   npm run test:e2e:app
//
// The app is launched with LOCALAPPDATA redirected to a throwaway folder, so
// it boots a fresh desk (own Postgres cluster, own storage, own secrets) and
// never touches the real desk data. Because the embedded Postgres port (5433)
// and sidecar port (3010) are fixed in the app, the suite REFUSES to run
// while the real desk app is open — global-setup aborts with a clear message
// instead of ever reusing a live cluster.
export const APP_CDP_PORT = 9222;

export default defineConfig({
  testDir: "./e2e-app",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // The suite drives one shared app instance — retries would re-enter a
  // dirty UI state. Fail fast instead.
  retries: 0,
  reporter: [["html", { open: "never", outputFolder: "playwright-report-app" }], ["list"]],
  globalSetup: "./e2e-app/global-setup.ts",
  globalTeardown: "./e2e-app/global-teardown.ts",
  timeout: 60_000,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "windows-app" }],
});
