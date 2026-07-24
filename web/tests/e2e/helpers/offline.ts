/**
 * Offline mode helpers for E2E tests
 *
 * Helpers for testing offline functionality including:
 * - Content caching (audio + transcript)
 * - Offline banner visibility
 */

import { Page, BrowserContext, expect } from "@playwright/test";

/**
 * Set the browser's offline state.
 *
 * @param context - Playwright browser context
 * @param offline - true to go offline, false to go online
 */
export async function setOffline(context: BrowserContext, offline: boolean): Promise<void> {
  await context.setOffline(offline);
}

/**
 * Wait for the offline banner to appear.
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait in ms (default: 5000)
 */
export async function waitForOfflineBanner(page: Page, timeout = 5000): Promise<void> {
  const banner = page.getByTestId("offline-banner");
  await banner.waitFor({ state: "visible", timeout });
}

/**
 * Wait for the offline banner to disappear.
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait in ms (default: 5000)
 */
export async function waitForOfflineBannerGone(page: Page, timeout = 5000): Promise<void> {
  const banner = page.getByTestId("offline-banner");
  await expect(banner).not.toBeVisible({ timeout });
}

/**
 * Find the cache button on the current page.
 * The cache button can be in the catalog list or the player controls.
 *
 * @param page - Playwright page object
 * @returns Locator for the cache button, or null if not found
 */
export async function findCacheButton(page: Page) {
  // Cache button has aria-label containing "cache" or "offline"
  const cacheButton = page.locator("button").filter({
    has: page.locator("svg"),
  }).filter({
    hasText: /cache|offline/i,
  }).or(
    page.locator("button[title*='cache' i], button[title*='offline' i]")
  ).first();

  if (await cacheButton.isVisible().catch(() => false)) {
    return cacheButton;
  }
  return null;
}

/**
 * Cache a recording by clicking the cache button and waiting for completion.
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait for caching to complete (default: 120000 for large files)
 */
export async function cacheRecording(page: Page, timeout = 120000): Promise<void> {
  const cacheButton = await findCacheButton(page);
  if (!cacheButton) {
    throw new Error("Cache button not found on page");
  }

  // Click to start caching
  await cacheButton.click();

  // Wait for the checkmark icon to appear (indicates cached state)
  // The button should contain a Check icon when cached
  await page.waitForFunction(
    () => {
      const buttons = document.querySelectorAll("button");
      for (const button of buttons) {
        const title = button.getAttribute("title") || button.getAttribute("aria-label") || "";
        if (/cached|offline/i.test(title)) {
          // Check if it has a check mark icon (lucide-react Check icon has a specific path)
          const svg = button.querySelector("svg");
          if (svg) {
            const paths = svg.querySelectorAll("path, polyline");
            for (const path of paths) {
              const d = path.getAttribute("d") || path.getAttribute("points") || "";
              // Check icon typically has a checkmark path
              if (d.includes("20 6") || d.includes("9 11") || d.includes("polyline")) {
                return true;
              }
            }
          }
        }
      }
      return false;
    },
    { timeout }
  );
}

/**
 * Verify the cache button shows a specific state.
 *
 * @param page - Playwright page object
 * @param state - Expected cache state
 * @param timeout - Maximum time to wait (default: 5000)
 */
export async function verifyCacheState(
  page: Page,
  state: "cached" | "uncached" | "caching" | "partial",
  timeout = 5000
): Promise<void> {
  const expectedTitle: Record<string, RegExp> = {
    cached: /cached|offline/i,
    uncached: /cache for offline|download/i,
    caching: /caching|downloading|\d+%/i,
    partial: /partial|resume|interrupted/i,
  };

  const button = page.locator(
    `button[title*='${state}' i], button[aria-label*='${state}' i]`
  ).or(
    page.locator("button").filter({ hasText: expectedTitle[state] })
  ).first();

  await expect(button).toBeVisible({ timeout });
}

/**
 * Wait for the service worker to be ready.
 * This is important for offline tests as SW handles caching.
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait (default: 10000)
 */
export async function waitForServiceWorker(page: Page, timeout = 10000): Promise<void> {
  await page.waitForFunction(
    () => {
      return (
        "serviceWorker" in navigator &&
        navigator.serviceWorker.controller !== null
      );
    },
    { timeout }
  );
}

/**
 * Clear the service worker audio cache.
 * This forces the SW to fetch from network on next audio request.
 *
 * @param page - Playwright page object
 */
export async function clearAudioCache(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const cache = await caches.open("besedy-audio-v3");
    const keys = await cache.keys();
    await Promise.all(keys.map((key) => cache.delete(key)));
  });
}
