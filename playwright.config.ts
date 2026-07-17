import { defineConfig, devices } from "@playwright/test";

// E2E stack ports — deliberately OFFSET from every dev/prod port so a running
// dev server (5173/5180), the desktop sidecar (3010), or the desk's embedded
// Postgres (5433) can never collide with — or be touched by — a test run.
// The whole stack (Postgres cluster, API, file storage) lives under
// e2e/.runtime and is rebuilt from scratch each run; it NEVER points at the
// live desk data (D:\SLDT or %LOCALAPPDATA%\SLDT).
export const E2E_WEB_PORT = 5273;
export const E2E_API_PORT = 3020;
export const E2E_PG_PORT = 5434;

export default defineConfig({
  testDir: "./e2e",
  // The app under test is a single stateful desk (one DB, one drawer) —
  // parallel workers would race each other's bookings. Keep runs serial.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev --workspace @stayvia/web -- --port ${E2E_WEB_PORT} --strictPort`,
    url: `http://127.0.0.1:${E2E_WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    // Point the frontend at the throwaway test API, not the desk sidecar.
    env: { VITE_API_URL: `http://127.0.0.1:${E2E_API_PORT}/api/v1` },
    timeout: 120_000,
  },
});
