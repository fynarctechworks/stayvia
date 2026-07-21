import { expect, test } from "@playwright/test";

import { loadFixtures, type Fixtures } from "./harness";
import { injectSession } from "./session";

// Smoke: the cloud web app boots against the throwaway stack — the public
// pages render, and an injected supabase-js session (minted JWT accepted by
// the API's E2E auth shim) lands an admin on their own hotel's dashboard.

let fx: Fixtures;
test.beforeAll(() => {
  fx = loadFixtures();
});

test.describe("cloud smoke", () => {
  test("signup page renders", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: /create your hotel/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /send verification code/i })).toBeVisible();
  });

  test("login page renders", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
  });

  test("injected session lands hotel A's admin on their dashboard", async ({ page }) => {
    await injectSession(page, { id: fx.hotelA.adminId, email: fx.hotelA.adminEmail });
    await page.goto("/dashboard");
    // Shell branding shows the tenant's own hotel name (from /auth/me).
    // The name renders twice (desktop sidebar + off-canvas mobile drawer);
    // filter to the copy that's actually visible at this viewport.
    await expect(
      page.getByText(fx.hotelA.hotelName).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 20_000 });
    // Dashboard KPI proves a business endpoint round-trip: the occupancy
    // tile totals exactly hotel A's 3 seeded rooms.
    await expect(page.getByText("Occupancy").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText(/\/ 3 rooms/).filter({ visible: true }).first()).toBeVisible();
  });
});
