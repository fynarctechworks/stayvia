import { chromium, expect, test, type Page } from "@playwright/test";

import { APP_CDP_PORT } from "../playwright-app.config";
import { DESK_ADMIN } from "../e2e/fixtures";

// Drives the REAL Windows executable over WebView2's CDP endpoint. These
// tests cover what the browser suite can't: the Rust shell's boot sequence,
// the api.exe watchdog, and the Data Storage card backed by real Tauri
// commands. One shared app instance — tests run serially and in order.

let page: Page;

test.beforeAll(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${APP_CDP_PORT}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("WebView2 exposed no browser context");
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
});

test.describe("windows app (real shell)", () => {
  test("boots a fresh desk to the PIN login and signs in", async () => {
    // The shell just initdb'd a brand-new cluster and seeded the first-run
    // admin — the exact out-of-box experience of a new PC install.
    await expect(page.getByLabel(/desk pin or password/i)).toBeVisible({ timeout: 30_000 });
    await page.getByLabel(/email/i).fill(DESK_ADMIN.email);
    await page.getByLabel(/desk pin or password/i).fill(DESK_ADMIN.pin);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("data storage card shows the throwaway location via real Tauri commands", async () => {
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByText(/data storage/i).first()).toBeVisible();
    // get_data_dir runs in the Rust shell; the shown path must be the
    // redirected LOCALAPPDATA anchor — proof the isolation actually held.
    await expect(page.getByText(/localappdata\\SLDT/i)).toBeVisible({ timeout: 10_000 });
  });

  test("watchdog revives a killed api.exe within seconds", async () => {
    // Murder the sidecar the way a crash or antivirus would.
    const { execFileSync } = await import("node:child_process");
    execFileSync("taskkill", ["/IM", "api.exe", "/F"], { stdio: "pipe" });

    // The Rust supervisor checks every 3s and respawns + health-gates.
    const deadline = Date.now() + 30_000;
    let alive = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch("http://127.0.0.1:3010/health");
        if (res.ok) {
          alive = true;
          break;
        }
      } catch {
        /* still down */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(alive, "sidecar did not come back within 30s").toBe(true);

    // And the UI keeps working against the revived API.
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByText(/occupancy/i).first()).toBeVisible({ timeout: 20_000 });
  });
});
