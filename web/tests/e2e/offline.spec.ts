/**
 * Offline mode E2E tests.
 *
 * Covers the offline banner, the download control, the service worker's
 * network fallback for streaming audio, the Downloads page, and offline
 * playback of a downloaded recording. Chromium only: Playwright's offline
 * emulation and service worker support are most reliable there.
 */

import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { URLS, FIRST_RECORDING } from "./helpers/fixtures";
import { waitForPageReady } from "./helpers/navigation";
import {
  clearOfflineStorage,
  downloadButton,
  downloadCurrentRecording,
  expectDownloadStatus,
  setOffline,
  waitForOfflineBanner,
  waitForOfflineBannerGone,
  waitForServiceWorker,
} from "./helpers/offline";

test.describe("Offline Mode", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Offline tests require Chromium");

  test.describe("Offline Banner", () => {
    test("shows banner with a Downloads shortcut when the network disconnects", async ({ page, context }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.catalog);
      await waitForPageReady(page);

      const banner = page.getByTestId("offline-banner");
      await expect(banner).not.toBeVisible();

      await setOffline(context, true);
      await waitForOfflineBanner(page);
      await expect(banner).toContainText(/offline/i);
      await expect(banner.getByRole("link", { name: /downloads|stažené/i })).toHaveAttribute(
        "href",
        "/downloads"
      );

      await setOffline(context, false);
      await waitForOfflineBannerGone(page);
    });
  });

  test.describe("Download control", () => {
    test("download button is visible and idle on the recording page", async ({ page }) => {
      await loginAs(page, "viewer");
      await clearOfflineStorage(page);
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      await expect(downloadButton(page)).toBeVisible({ timeout: 10_000 });
      await expectDownloadStatus(page, "none");
    });

    test("downloads a recording and lists it on the Downloads page", async ({ page }) => {
      await loginAs(page, "viewer");
      await clearOfflineStorage(page);
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      await downloadCurrentRecording(page);

      await page.goto("/downloads");
      await waitForPageReady(page);
      const card = page.getByTestId(`download-card-${FIRST_RECORDING.hash}`);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-status", "complete");

      await page.getByTestId(`download-remove-${FIRST_RECORDING.hash}`).click();
      await expect(card).not.toBeVisible();
      await expect(page.getByTestId("downloads-empty")).toBeVisible();
    });
  });

  test.describe("Service Worker network fallback", () => {
    test("streams audio that is not downloaded straight from the server", async ({ page }) => {
      await loginAs(page, "viewer");
      await clearOfflineStorage(page);
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      const playButton = page.getByTestId("audio-play-button");
      await expect(playButton).toBeVisible();

      const audioResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/catalogs/") &&
          response.url().includes("/recordings/") &&
          response.url().endsWith("/audio"),
        { timeout: 10_000 }
      );

      await playButton.click();

      const audioResponse = await audioResponsePromise;
      expect(audioResponse.status()).not.toBe(403);
      await expect(playButton).toHaveAttribute("aria-label", /pause|buffering|reconnecting/i, {
        timeout: 10_000,
      });
    });
  });

  test.describe("Offline playback", () => {
    test("a downloaded recording opens and plays without a connection", async ({ page, context }) => {
      await loginAs(page, "viewer");
      await clearOfflineStorage(page);
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      await downloadCurrentRecording(page);

      await setOffline(context, true);
      await waitForOfflineBanner(page);

      // A full reload offline must be served by the service worker.
      await page.reload();
      await expect(page.getByTestId("audio-play-button")).toBeVisible({ timeout: 15_000 });
      await expectDownloadStatus(page, "complete", 15_000);

      const playButton = page.getByTestId("audio-play-button");
      await playButton.click();
      await expect(playButton).toHaveAttribute("aria-label", /pause|buffering/i, { timeout: 10_000 });

      await setOffline(context, false);
    });

    test("an offline navigation to an unknown page lands on Downloads", async ({ page, context }) => {
      await loginAs(page, "viewer");
      await page.goto("/downloads");
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      await setOffline(context, true);
      await page.goto(`${URLS.catalog}/does-not-exist/event/999999`);
      await expect(page).toHaveURL(/\/downloads\?from=/);
      await expect(page.getByTestId("downloads-offline-redirect")).toBeVisible();

      await setOffline(context, false);
    });
  });
});
