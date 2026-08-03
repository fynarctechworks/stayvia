import { expect, test } from "@playwright/test";

import { loadFixtures, type Fixtures } from "./harness";
import { injectSession } from "./session";

// Responsive audit: every authed route must never scroll the PAGE
// horizontally, at any device width. Blocks inside a page may scroll
// themselves (overflow-x-auto wrappers) — the invariant is that the
// document itself fits the viewport.
//
// Runs in the "chromium" project only (viewport is overridden per width
// below, so running it again under the mobile/tablet projects would just
// duplicate work).

const WIDTHS = [360, 390, 640, 768, 834, 1024, 1280] as const;

const ROUTES = [
  "/dashboard",
  "/reservations",
  "/reservations/new?mode=walkin",
  "/rooms",
  "/housekeeping",
  "/calendar",
  "/guests",
  "/invoices",
  "/collections",
  "/credits",
  "/expenses",
  "/reports",
  "/activity",
  "/notifications",
  "/staff",
  "/settings",
] as const;

let fx: Fixtures;
test.beforeAll(() => {
  fx = loadFixtures();
});

test.describe("no horizontal page overflow", () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "audit runs once, in the chromium project",
    );
  });

  for (const route of ROUTES) {
    test(`${route} fits at every width`, async ({ page }) => {
      await injectSession(page, { id: fx.hotelA.adminId, email: fx.hotelA.adminEmail });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route, { waitUntil: "networkidle" });
        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          return Math.max(doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth);
        });
        expect(overflow, `${route} overflows by ${overflow}px at ${width}px wide`).toBeLessThanOrEqual(1);
      }
    });
  }
});
