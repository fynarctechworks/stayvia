import { test as base, expect, type Page } from "@playwright/test";

// Desk credentials seeded by the API's first-run bootstrap on the throwaway
// E2E database (same as a fresh install).
export const DESK_ADMIN = {
  email: "admin@hoteldesk.local",
  pin: "424242",
} as const;

// The frontend decides "desktop/offline mode" by probing for Tauri globals.
// Planting the marker before any app code runs makes the browser-hosted
// frontend behave exactly like the packaged Windows app: PIN login, local
// JWT transport, desk status strip — the mode the desk actually runs in.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    });
    await use(page);
  },
});

export { expect };

/** Log in through the real PIN screen and land on the dashboard. */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(DESK_ADMIN.email);
  await page.getByLabel(/desk pin or password/i).fill(DESK_ADMIN.pin);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible({
    timeout: 15_000,
  });
}
