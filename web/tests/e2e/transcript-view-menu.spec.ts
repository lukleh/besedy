/**
 * The transcript's View menu on desktop: it stays open while layers are
 * ticked, and opening it does not shift the page.
 *
 * Radix menus lock page scrolling and give the body a right margin the width
 * of the scrollbar. The page keeps its scrollbar (html sets overflow-x), so
 * that margin moved the page left until globals.css zeroed it. The shift only
 * shows with a real scrollbar, which Playwright hides in headless Chromium by
 * default, so this file turns them back on.
 */
import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { FIRST_RECORDING, URLS } from "./helpers/fixtures";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test.describe("Transcript View menu", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Desktop dropdown with a classic scrollbar; Chromium only"
    );
    await loginAs(page, "viewer");
    await page.goto(URLS.recording(FIRST_RECORDING.hash));
    await expect(page.locator("[data-segment-index]").first()).toBeVisible({
      timeout: 15000,
    });
  });

  test("opening the menu does not shift the page", async ({ page }) => {
    const scrollbar = await page.evaluate(
      () => window.innerWidth - document.documentElement.clientWidth
    );
    expect(scrollbar, "the page shows a classic scrollbar").toBeGreaterThan(0);

    // Right-aligned, so a margin added to the body moves it.
    const follow = page.locator("button[aria-pressed]").first();
    const before = await follow.boundingBox();
    await page.getByRole("button", { name: /^View/ }).first().click();
    await expect(page.getByRole("menuitemcheckbox").first()).toBeVisible();
    const after = await follow.boundingBox();

    expect(after?.x).toBe(before?.x);
  });

  test("stays open while layers are ticked", async ({ page }) => {
    await page.getByRole("button", { name: /^View/ }).first().click();
    const timestamps = page.getByRole("menuitemcheckbox", { name: /Timestamps/ });
    await timestamps.click();

    await expect(timestamps).toBeVisible();
    await expect(timestamps).toHaveAttribute("aria-checked", "false");
    await timestamps.click();
    await expect(timestamps).toHaveAttribute("aria-checked", "true");
  });
});
