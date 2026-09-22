/**
 * Offline mode helpers for E2E tests.
 *
 * The download button exposes `data-testid="download-button"` and a
 * `data-status` attribute mirroring the registry status
 * (none | queued | downloading | paused | error | complete).
 */

import { Page, BrowserContext, expect } from "@playwright/test";

export type DownloadButtonStatus =
  | "none"
  | "queued"
  | "downloading"
  | "paused"
  | "error"
  | "complete";

export async function setOffline(context: BrowserContext, offline: boolean): Promise<void> {
  await context.setOffline(offline);
}

/** The crossed-Wi-Fi indicator in the header, the app's single connectivity cue. */
export async function waitForOfflineIndicator(page: Page, timeout = 5000): Promise<void> {
  await page.getByTestId("offline-indicator").waitFor({ state: "visible", timeout });
}

export async function waitForOfflineIndicatorGone(page: Page, timeout = 5000): Promise<void> {
  await expect(page.getByTestId("offline-indicator")).not.toBeVisible({ timeout });
}

/** The first visible download button on the page (player, card, or event header). */
export function downloadButton(page: Page) {
  return page.getByTestId("download-button").filter({ visible: true }).first();
}

export async function expectDownloadStatus(
  page: Page,
  status: DownloadButtonStatus,
  timeout = 5000
): Promise<void> {
  await expect(downloadButton(page)).toHaveAttribute("data-status", status, { timeout });
}

/**
 * Start a download from the current page and wait for it to complete.
 * Large files can take a while, hence the generous default timeout.
 */
export async function downloadCurrentRecording(page: Page, timeout = 120_000): Promise<void> {
  const button = downloadButton(page);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("data-status", "none");
  await button.click();
  await expect(button).toHaveAttribute("data-status", "complete", { timeout });
}

/** Wait until a service worker controls the page. */
export async function waitForServiceWorker(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => "serviceWorker" in navigator && navigator.serviceWorker.controller !== null,
    { timeout }
  );
}

/** Delete every offline cache and the downloads registry. */
export async function clearOfflineStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("besedy-")).map((name) => caches.delete(name)));
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("besedy-offline");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });
}
