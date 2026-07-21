import { defineConfig, devices } from "@playwright/test";

// E2E stack ports — deliberately OFFSET from every dev/prod port so a running
// dev server (5173/5180) or dev API (3001) can never collide with — or be
// touched by — a test run. The whole stack (throwaway Postgres cluster on
// 5434, API on 3020 with fake secrets + the E2E auth shim, vite on 5273)
// lives under e2e/.runtime and is rebuilt from scratch each run; it NEVER
// points at live Supabase/Redis/Razorpay (see e2e/harness.ts).
export const E2E_WEB_PORT = 5273;
export const E2E_API_PORT = 3020;
export const E2E_PG_PORT = 5434;

export default defineConfig({
  testDir: "./e2e",
  // The suites share one seeded stack and the billing suite mutates hotel
  // A's subscription row mid-file — parallel workers would race it. Serial.
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
    // Point the frontend at the throwaway test API and a fake Supabase.
    // Real process env beats .env.development in Vite, so these can never
    // leak dev/prod values into the suite. The supabase-js client is only
    // constructed with the fake URL — the injected-session flow (e2e/
    // session.ts) never actually calls it.
    env: {
      VITE_API_URL: `http://127.0.0.1:${E2E_API_PORT}/api/v1`,
      VITE_SUPABASE_URL: "http://e2e-supabase.invalid",
      VITE_SUPABASE_ANON_KEY: "e2e-fake-anon-key-not-a-real-secret",
    },
    timeout: 120_000,
  },
});
