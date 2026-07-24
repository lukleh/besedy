/**
 * Offline mode E2E tests for Besedy.
 *
 * Tests the offline functionality including:
 * - Manual content caching from the player UI
 * - Offline banner visibility
 * - Service worker network fallback behavior
 *
 * Note: These tests require Chromium for best Service Worker support.
 */

import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { URLS, FIRST_RECORDING } from "./helpers/fixtures";
import { waitForPageReady } from "./helpers/navigation";
import {
  setOffline,
  waitForOfflineBanner,
  waitForOfflineBannerGone,
  waitForServiceWorker,
  clearAudioCache,
} from "./helpers/offline";

test.describe("Offline Mode", () => {
  // Use only Chromium for offline tests (best SW support)
  test.skip(({ browserName }) => browserName !== "chromium", "Offline tests require Chromium");

  test.describe("Offline Banner", () => {
    test("shows banner when network disconnected", async ({ page, context }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.catalog);
      await waitForPageReady(page);

      // Verify banner is not shown when online
      const banner = page.getByTestId("offline-banner");
      await expect(banner).not.toBeVisible();

      // Go offline
      await setOffline(context, true);
      await waitForOfflineBanner(page);

      // Verify banner content
      await expect(banner).toContainText(/offline/i);

      // Go back online
      await setOffline(context, false);
      await waitForOfflineBannerGone(page);
    });
  });

  test.describe("Content Caching", () => {
    test("cache button is visible on recording page", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      // The audio player renders two copies of the cache button (one for wide
      // viewports, one for narrow) and toggles them via Tailwind responsive
      // classes. Filter to the visible copy so the assertion works across all
      // breakpoints.
      const cacheButton = page
        .locator(
          "button[title*='cache' i], button[title*='offline' i], button[aria-label*='cache' i], button[aria-label*='offline' i]"
        )
        .filter({ visible: true })
        .first();
      await expect(cacheButton).toBeVisible({ timeout: 10000 });
    });

    // This test is slow as it downloads actual audio
    test.skip("can cache recording for offline use", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      // Find and click cache button
      const cacheButton = page.locator(
        "button[title*='cache' i], button[title*='offline' i]"
      ).first();
      await cacheButton.click();

      // Wait for caching to complete (this can take a while for large files)
      // The button title should change to indicate cached status
      await expect(cacheButton).toHaveAttribute(
        "title",
        /cached/i,
        { timeout: 120000 }
      );
    });
  });

  test.describe("Service Worker Credentials", () => {
    test("uncached audio plays when SW falls back to network", async ({ page }) => {
      // This test verifies that when the SW intercepts an audio request
      // and the audio is NOT cached, it correctly includes credentials
      // when falling back to network fetch. Without credentials, the
      // audio API would return 403 Access Denied.

      await loginAs(page, "viewer");
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);

      // Wait for SW to be controlling the page
      await waitForServiceWorker(page);

      // Clear the audio cache to force network fallback
      await clearAudioCache(page);

      // Click play - this will trigger audio fetch through SW
      const playButton = page.getByTestId("audio-play-button");
      await expect(playButton).toBeVisible();

      // Set up promise to wait for audio response and capture status
      const audioResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/catalogs/") &&
          response.url().includes("/recordings/") &&
          response.url().includes("/audio"),
        { timeout: 10000 }
      );

      await playButton.click();

      // Wait for audio request to complete and verify no 403
      const audioResponse = await audioResponsePromise;
      expect(audioResponse.status()).not.toBe(403);

      // Verify the player is in playing or buffering state (not error)
      // The button should show pause icon or loading spinner
      await expect(playButton).toHaveAttribute(
        "aria-label",
        /pause|buffering|reconnecting/i,
        { timeout: 10000 }
      );
    });
  });

  test.describe("Offline Playback", () => {
    // This test requires pre-cached content which is complex to set up
    // Skipping for now - manual testing recommended
    test.skip("cached recording plays when offline", async ({ page, context }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      // Cache the recording first
      const cacheButton = page.locator(
        "button[title*='cache' i], button[title*='offline' i]"
      ).first();
      await cacheButton.click();

      // Wait for caching to complete
      await expect(cacheButton).toHaveAttribute("title", /cached/i, { timeout: 120000 });

      // Go offline
      await setOffline(context, true);
      await waitForOfflineBanner(page);

      // Audio player should still work
      const playButton = page.getByTestId("audio-play-button");
      await expect(playButton).toBeVisible();

      // Should be able to play
      await playButton.click();
      await expect(playButton).toHaveAttribute("aria-label", /pause|reconnecting/i, { timeout: 10000 });

      // Transcript should still be visible (if cached)
      const transcriptHeading = page.getByRole("heading", { name: /transcript/i });
      // Note: transcript visibility depends on whether it was cached
      // This assertion may need adjustment based on implementation
      await expect(transcriptHeading).toBeVisible({ timeout: 5000 });

      // Go back online
      await setOffline(context, false);
    });
  });
});
