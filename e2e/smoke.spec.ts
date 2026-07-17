import { expect, loginAsAdmin, test } from "./fixtures";

// Smoke: the desk boots, PIN login works against the isolated stack, the
// dashboard renders its money tiles, and core navigation responds. This is
// the "is the app fundamentally alive" gate every deeper suite builds on.

test.describe("desk smoke", () => {
  test("login page runs in desk (PIN) mode", async ({ page }) => {
    await page.goto("/login");
    // Desktop-mode marker worked: the password field is the desk PIN field.
    await expect(page.getByLabel(/desk pin or password/i)).toBeVisible();
    // No cloud reset link on the desk — admins reset PINs from Settings.
    await expect(page.getByText(/forgot\? ask an admin/i)).toBeVisible();
  });

  test("admin signs in with the seeded PIN and sees the dashboard", async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.getByText(/occupancy/i).first()).toBeVisible();
    await expect(page.getByText(/revenue today/i).first()).toBeVisible();
  });

  test("sidebar navigation reaches the core pages", async ({ page }) => {
    await loginAsAdmin(page);
    for (const [link, heading] of [
      ["Rooms", /rooms/i],
      ["Reservations", /reservations/i],
      ["Guests", /guests/i],
      ["Settings", /settings/i],
    ] as const) {
      await page.getByRole("link", { name: link }).click();
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    }
  });

  test("wrong PIN is rejected with a generic error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@hoteldesk.local");
    await page.getByLabel(/desk pin or password/i).fill("000000");
    await page.getByRole("button", { name: /sign in/i }).click();
    // The API's actual rejection message must render — asserting only "still
    // on /login" would also pass on a network failure, hiding a broken stack.
    await expect(page.getByText(/credentials are incorrect/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /dashboard/i })).toHaveCount(0);
  });
});
