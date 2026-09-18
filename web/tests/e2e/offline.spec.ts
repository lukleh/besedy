/**
 * Offline mode E2E tests.
 *
 * Covers the offline banner, the download control, the service worker's
 * network fallback for streaming audio, the Downloads page, and offline
 * playback of a downloaded recording. Chromium only: Playwright's offline
 * emulation and service worker support are most reliable there.
 */

import { test, expect } from './helpers/base-test';
import { loginAs } from './helpers/auth';
import { URLS, FIRST_RECORDING, TEST_CATALOG_ID } from './helpers/fixtures';
import { waitForPageReady } from './helpers/navigation';
import {
  clearOfflineStorage,
  downloadButton,
  downloadCurrentRecording,
  expectDownloadStatus,
  setOffline,
  waitForOfflineBanner,
  waitForOfflineBannerGone,
  waitForServiceWorker,
} from './helpers/offline';

test.describe('Offline Mode', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Offline tests require Chromium',
  );

  test.describe('Offline Banner', () => {
    test('shows banner with a Downloads shortcut when the network disconnects', async ({
      page,
      context,
    }) => {
      await loginAs(page, 'viewer');
      await page.goto(URLS.catalog);
      await waitForPageReady(page);

      const banner = page.getByTestId('offline-banner');
      await expect(banner).not.toBeVisible();

      await setOffline(context, true);
      await waitForOfflineBanner(page);
      await expect(banner).toContainText(/offline/i);
      await expect(
        banner.getByRole('link', { name: /downloads|stažené/i }),
      ).toHaveAttribute('href', '/downloads');

      await setOffline(context, false);
      await waitForOfflineBannerGone(page);
    });
  });

  test.describe('Download control', () => {
    test('download button is visible and idle on the recording page', async ({
      page,
    }) => {
      await loginAs(page, 'viewer');
      await clearOfflineStorage(page);
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      await expect(downloadButton(page)).toBeVisible({ timeout: 10_000 });
      await expectDownloadStatus(page, 'none');
    });

    test('downloads a recording and lists it on the Downloads page', async ({
      page,
    }) => {
      await loginAs(page, 'viewer');
      await clearOfflineStorage(page);
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      await downloadCurrentRecording(page);

      await page.goto('/downloads');
      await waitForPageReady(page);
      const card = page.getByTestId(`download-card-${FIRST_RECORDING.hash}`);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('data-status', 'complete');

      await page.getByTestId(`download-remove-${FIRST_RECORDING.hash}`).click();
      await expect(card).not.toBeVisible();
      await expect(page.getByTestId('downloads-empty')).toBeVisible();
    });
  });

  test.describe('Service Worker network fallback', () => {
    test('streams audio that is not downloaded straight from the server', async ({
      page,
    }) => {
      await loginAs(page, 'viewer');
      await clearOfflineStorage(page);
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      const playButton = page.getByTestId('audio-play-button');
      await expect(playButton).toBeVisible();

      const audioResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/catalogs/') &&
          response.url().includes('/recordings/') &&
          response.url().endsWith('/audio'),
        { timeout: 10_000 },
      );

      await playButton.click();

      const audioResponse = await audioResponsePromise;
      expect(audioResponse.status()).not.toBe(403);
      await expect(playButton).toHaveAttribute(
        'aria-label',
        /pause|buffering|reconnecting/i,
        {
          timeout: 10_000,
        },
      );
    });
  });

  test.describe('Offline playback', () => {
    test('a downloaded recording plays offline and syncs progress on reconnect', async ({
      page,
      context,
    }) => {
      // Use a separate account because progress is backend state and the
      // service-worker streaming test runs concurrently as the viewer.
      await loginAs(page, 'listener');
      await clearOfflineStorage(page);
      const progressUrl = `/api/catalogs/${TEST_CATALOG_ID}/recordings/${FIRST_RECORDING.hash}/progress`;
      const initialProgress = await page.request.put(progressUrl, {
        data: {
          positionSec: 20,
          durationSec: 30,
          completed: false,
        },
      });
      expect(initialProgress.ok()).toBe(true);
      await page.goto(URLS.recording(FIRST_RECORDING.hash));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      // A partial download is valid resumable state. Its next Range request
      // passes through the worker and must not make the worker delete chunk 0.
      const partialDownloadSurvived = await page.evaluate(
        async ({ catalogId, hash }) => {
          const audioUrl = new URL(
            `/api/catalogs/${catalogId}/recordings/${hash}/audio`,
            window.location.origin,
          ).toString();
          const metaKey = `${audioUrl}?_meta`;
          const chunkKey = `${audioUrl}?_chunk=0`;
          const cache = await caches.open('besedy-audio-v5');
          await cache.put(
            chunkKey,
            new Response(new Uint8Array([0, 1, 2, 3, 4])),
          );
          await cache.put(
            metaKey,
            new Response(
              JSON.stringify({
                totalSize: 10,
                chunkCount: 1,
                chunkSizes: [5],
                contentType: 'audio/webm',
                complete: false,
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );

          const response = await fetch(audioUrl, {
            headers: { Range: 'bytes=5-9' },
          });
          await response.arrayBuffer();
          const survived = Boolean(
            (await cache.match(metaKey)) && (await cache.match(chunkKey)),
          );
          await Promise.all([cache.delete(metaKey), cache.delete(chunkKey)]);
          return survived;
        },
        { catalogId: TEST_CATALOG_ID, hash: FIRST_RECORDING.hash },
      );
      expect(partialDownloadSurvived).toBe(true);

      await downloadCurrentRecording(page);

      // Completing a download warms the real Downloads route automatically.
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const cache = await caches.open('besedy-offline-shell-v1');
            return Boolean(await cache.match('/downloads'));
          }),
        )
        .toBe(true);

      await setOffline(context, true);
      await page.goto('/downloads');
      const card = page.getByTestId(`download-card-${FIRST_RECORDING.hash}`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toHaveAttribute('data-status', 'complete');
      await card.getByRole('button', { name: /open|otevřít/i }).click();

      await expect(page.getByTestId('download-detail')).toBeVisible();
      await expect(page).toHaveURL(/\/downloads\?.*item=/);
      await expect(page.getByTestId('audio-play-button')).toBeVisible({
        timeout: 15_000,
      });

      const playButton = page.getByTestId('audio-play-button');
      await playButton.click();
      await expect(playButton).toHaveAttribute(
        'aria-label',
        /pause|buffering/i,
        { timeout: 10_000 },
      );

      await playButton.click();
      await expect(playButton).toHaveAttribute('aria-label', /play/i);
      const progressSlider = page.getByRole('slider', {
        name: 'Playback progress',
      });
      await progressSlider.press('Home');
      // The shared player slider uses 100 ms steps.
      for (let step = 0; step < 50; step += 1) {
        await progressSlider.press('ArrowRight');
      }
      await expect(progressSlider).toHaveAttribute('aria-valuenow', '5');
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const request = indexedDB.open('besedy-offline');
            const database = await new Promise<IDBDatabase>(
              (resolve, reject) => {
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              },
            );
            const transaction = database.transaction(
              'pendingPlaybackProgress',
              'readonly',
            );
            const entries = await new Promise<Array<{ positionSec: number }>>(
              (resolve, reject) => {
                const getAll = transaction
                  .objectStore('pendingPlaybackProgress')
                  .getAll();
                getAll.onsuccess = () => resolve(getAll.result);
                getAll.onerror = () => reject(getAll.error);
              },
            );
            database.close();
            return entries[0]?.positionSec ?? null;
          }),
        )
        .toBe(5);

      await setOffline(context, false);
      // CDP updates navigator.onLine but does not reliably emit the browser
      // lifecycle event that drives reconnect work in the application.
      await page.evaluate(() => {
        window.dispatchEvent(new Event('online'));
      });
      await expect
        .poll(
          async () => {
            const response = await page.request.get(progressUrl);
            if (!response.ok()) return null;
            const body = (await response.json()) as {
              progress: { positionSec: number } | null;
            };
            return body.progress?.positionSec ?? null;
          },
          { timeout: 15_000 },
        )
        .toBe(5);
    });

    test('an offline navigation to an unknown page lands on Downloads', async ({
      page,
      context,
    }) => {
      await loginAs(page, 'viewer');
      await page.goto('/downloads');
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      await setOffline(context, true);
      await page.goto(`${URLS.catalog}/does-not-exist/event/999999`);
      await expect(page).toHaveURL(/\/downloads\?from=/);
      await expect(
        page.getByTestId('downloads-offline-redirect'),
      ).toBeVisible();

      await setOffline(context, false);
    });
  });
});
