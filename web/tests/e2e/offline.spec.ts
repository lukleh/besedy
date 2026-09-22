/**
 * Offline mode E2E tests.
 *
 * Covers the offline banner, the download control, the service worker's
 * network fallback for streaming audio, the Downloads page, and offline
 * playback of a downloaded recording. Chromium only: Playwright's offline
 * emulation and service worker support are most reliable there.
 */

import { test, expect } from './helpers/base-test';
import type { APIRequestContext } from '@playwright/test';
import { loginAs } from './helpers/auth';
import {
  URLS,
  FIRST_RECORDING,
  TEST_AUDIO_FILES,
  TEST_CATALOG_ID,
  TEST_EVENTS,
} from './helpers/fixtures';
import { waitForPageReady } from './helpers/navigation';
import {
  clearOfflineStorage,
  downloadButton,
  downloadCurrentRecording,
  expectDownloadStatus,
  setOffline,
  waitForOfflineIndicator,
  waitForOfflineIndicatorGone,
  waitForServiceWorker,
} from './helpers/offline';

/**
 * Playwright's WebKit build cannot navigate to a document served by a
 * service worker while offline ("WebKit encountered an internal error").
 * Real Safari is verified on physical devices (#163 step 0).
 */
function skipOfflineNavigationOnWebKit(browserName: string) {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot load a service-worker-served document offline',
  );
}

async function getEventIdByTitle(
  request: APIRequestContext,
  title: string,
): Promise<number> {
  const params = new URLSearchParams({
    group: TEST_CATALOG_ID,
    search: title,
    limit: '50',
  });
  const response = await request.get(
    `/api/catalog-events?${params.toString()}`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    events: Array<{ id: number; title: string | null }>;
  };
  const event = body.events.find((item) => item.title === title);
  if (!event) throw new Error(`Seeded event not found: ${title}`);
  return event.id;
}

test.describe('Offline Mode', () => {
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'Offline tests require Chromium or WebKit',
  );

  test.describe('Connectivity indicator', () => {
    test('shows a crossed-Wi-Fi indicator in the header that leads to Downloads', async ({
      page,
      context,
    }) => {
      await loginAs(page, 'viewer');
      await page.goto(URLS.catalog);
      await waitForPageReady(page);

      const indicator = page.getByTestId('offline-indicator');
      await expect(indicator).not.toBeVisible();

      await setOffline(context, true);
      await waitForOfflineIndicator(page);
      await expect(indicator).toHaveAttribute('href', '/downloads');
      await expect(indicator).toHaveAccessibleName(/offline/i);

      await setOffline(context, false);
      await waitForOfflineIndicatorGone(page);
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
    test('playback that started online continues uninterrupted when connectivity drops', async ({
      page,
      context,
    }) => {
      await loginAs(page, 'listener');
      await clearOfflineStorage(page);
      const event = TEST_EVENTS[0];
      const eventId = await getEventIdByTitle(page.request, event.title);

      await page.goto(URLS.event(eventId));
      await waitForPageReady(page);
      await waitForServiceWorker(page);
      const eventDownload = page
        .getByTestId('download-button')
        .filter({ visible: true })
        .filter({ has: page.locator('svg') })
        .first();
      await eventDownload.click();
      await expect(eventDownload).toHaveAttribute('data-status', 'complete', {
        timeout: 120_000,
      });

      // Play from the completed package while still online.
      const audio = page.locator('audio');
      await page.getByTestId('audio-play-button').click();
      await expect
        .poll(
          () => audio.evaluate((element: HTMLAudioElement) => element.currentTime),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(2);
      const beforeOffline = await audio.evaluate(
        (element: HTMLAudioElement) => element.currentTime,
      );

      // Pull the plug mid-stream. Nothing should stall, error, or pause.
      await setOffline(context, true);
      await waitForOfflineIndicator(page);
      await page.waitForTimeout(4000);
      await expect
        .poll(
          () =>
            audio.evaluate((element: HTMLAudioElement) => ({
              currentTime: element.currentTime,
              error: element.error?.code ?? null,
              paused: element.paused,
              ended: element.ended,
            })),
          { timeout: 5_000 },
        )
        .toMatchObject({ error: null, paused: false, ended: false });
      const afterOffline = await audio.evaluate(
        (element: HTMLAudioElement) => element.currentTime,
      );
      expect(afterOffline).toBeGreaterThan(beforeOffline + 3);
      await expect(page.getByTestId('audio-play-button')).toHaveAttribute(
        'aria-label',
        /pause|buffering/i,
      );

      await setOffline(context, false);
    });

    test('an already-open downloaded event keeps playing after connectivity drops', async ({
      page,
      context,
    }) => {
      await loginAs(page, 'listener');
      await clearOfflineStorage(page);
      const event = TEST_EVENTS[0];
      const eventId = await getEventIdByTitle(page.request, event.title);

      await page.goto(URLS.event(eventId));
      await waitForPageReady(page);
      await waitForServiceWorker(page);
      const eventDownload = page
        .getByTestId('download-button')
        .filter({ visible: true })
        .filter({ has: page.locator('svg') })
        .first();
      await eventDownload.click();
      await expect(eventDownload).toHaveAttribute('data-status', 'complete', {
        timeout: 120_000,
      });

      // The page is already open; only the network goes away.
      await setOffline(context, true);
      await waitForOfflineIndicator(page);

      const audio = page.locator('audio');
      const needsInlineAudio = await page.evaluate(
        () =>
          /AppleWebKit\//.test(navigator.userAgent) &&
          /Android|iPhone|iPad|iPod/.test(navigator.userAgent),
      );
      if (needsInlineAudio) {
        await expect(audio).toHaveAttribute('src', /^data:audio\//, {
          timeout: 15_000,
        });
      }
      await page.getByTestId('audio-play-button').click();
      await expect
        .poll(
          () => audio.evaluate((element: HTMLAudioElement) => element.currentTime),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0.5);
      await expect(eventDownload).toHaveAttribute('data-status', 'complete');

      await setOffline(context, false);
    });

    test('a downloaded event advances playback when opened from Downloads offline', async ({
      page,
      context,
      browserName,
    }) => {
      skipOfflineNavigationOnWebKit(browserName);
      await loginAs(page, 'listener');
      await clearOfflineStorage(page);
      const event = TEST_EVENTS[0];
      const eventId = await getEventIdByTitle(page.request, event.title);
      const primaryRecording = TEST_AUDIO_FILES.find(
        (recording) => recording.shortHash === event.primaryRecording,
      );
      if (!primaryRecording) throw new Error('Seeded primary recording not found');

      await page.goto(URLS.event(eventId));
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      const eventDownload = page
        .getByTestId('download-button')
        .filter({ visible: true })
        .filter({ has: page.locator('svg') })
        .first();
      await expect(eventDownload).toHaveAttribute('data-status', 'none');
      await eventDownload.click();
      await expect(eventDownload).toHaveAttribute('data-status', 'complete', {
        timeout: 120_000,
      });
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const cache = await caches.open('besedy-offline-shell-v1');
            return Boolean(await cache.match('/downloads'));
          }),
        )
        .toBe(true);

      await page.goto('/downloads');
      const card = page.getByTestId(
        `download-card-${primaryRecording.hash}`,
      );
      await expect(card).toContainText(event.title, { timeout: 15_000 });
      await setOffline(context, true);
      await waitForOfflineIndicator(page);
      await card.getByRole('link', { name: /open|otevřít/i }).click();
      // Downloads delegates to the normal event page, served offline by the
      // worker at its own URL.
      await expect(page).toHaveURL(
        new RegExp(`/catalog/${TEST_CATALOG_ID}/event/${eventId}$`),
        { timeout: 15_000 },
      );

      const audio = page.locator('audio');
      const isAndroid = await page.evaluate(() =>
        /Android/.test(navigator.userAgent),
      );
      if (isAndroid) {
        await expect(audio).toHaveAttribute('src', /^data:audio\//);
      }
      await page.getByTestId('audio-play-button').click();
      await expect
        .poll(
          () =>
            audio.evaluate((element: HTMLAudioElement) => ({
              currentTime: element.currentTime,
              error: element.error?.code ?? null,
              paused: element.paused,
              readyState: element.readyState,
            })),
          { timeout: 15_000 },
        )
        .toMatchObject({
          currentTime: expect.any(Number),
          error: null,
          paused: false,
        });
      await expect
        .poll(
          () =>
            audio.evaluate(
              (element: HTMLAudioElement) => element.currentTime,
            ),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0.5);
    });

    test('a downloaded recording plays offline and syncs progress on reconnect', async ({
      page,
      context,
      browserName,
    }) => {
      skipOfflineNavigationOnWebKit(browserName);
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
      await card.getByRole('link', { name: /open|otevřít/i }).click();

      await expect(page).toHaveURL(
        new RegExp(`/catalog/${TEST_CATALOG_ID}/recording/${FIRST_RECORDING.hash}$`),
        { timeout: 15_000 },
      );
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

    test('an offline navigation keeps its URL and explains what is unavailable', async ({
      page,
      context,
      browserName,
    }) => {
      skipOfflineNavigationOnWebKit(browserName);
      await loginAs(page, 'viewer');
      await page.goto('/downloads');
      await waitForPageReady(page);
      await waitForServiceWorker(page);

      await setOffline(context, true);
      await page.goto('/settings');
      await expect(page).toHaveURL(/\/settings$/);
      await expect(page.getByTestId('offline-unavailable')).toBeVisible();
      await expect(page.getByRole('banner')).toBeVisible();

      await setOffline(context, false);
    });

    test('a downloaded event cold-starts at its normal URL and is reachable from the catalog list offline', async ({
      page,
      context,
      browserName,
    }) => {
      skipOfflineNavigationOnWebKit(browserName);
      await loginAs(page, 'listener');
      await clearOfflineStorage(page);
      const event = TEST_EVENTS[0];
      const eventId = await getEventIdByTitle(page.request, event.title);

      await page.goto(URLS.event(eventId));
      await waitForPageReady(page);
      await waitForServiceWorker(page);
      const eventDownload = page
        .getByTestId('download-button')
        .filter({ visible: true })
        .filter({ has: page.locator('svg') })
        .first();
      await eventDownload.click();
      await expect(eventDownload).toHaveAttribute('data-status', 'complete', {
        timeout: 120_000,
      });
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const cache = await caches.open('besedy-offline-shell-v1');
            return Boolean(await cache.match('/downloads'));
          }),
        )
        .toBe(true);

      // A fresh document at the normal event URL, without a connection.
      await setOffline(context, true);
      await page.goto(URLS.event(eventId));
      await expect(page).toHaveURL(
        new RegExp(`/catalog/${TEST_CATALOG_ID}/event/${eventId}$`),
      );
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(page.getByTestId('audio-play-button')).toBeVisible({
        timeout: 15_000,
      });

      // The catalog list shows the downloaded events and opens one.
      await page.goto(URLS.catalog);
      await expect(page.getByTestId('local-event-list')).toBeVisible({
        timeout: 15_000,
      });
      // The list renders cards on phones and table rows on desktop.
      const eventCard = page
        .getByTestId(`event-card-${eventId}`)
        .filter({ visible: true });
      if ((await eventCard.count()) > 0) {
        await eventCard.first().click();
      } else {
        await page
          .getByRole('row')
          .filter({ has: page.getByTestId(`event-downloaded-${eventId}`) })
          .click();
      }
      await expect(page).toHaveURL(
        new RegExp(`/catalog/${TEST_CATALOG_ID}/event/${eventId}$`),
        { timeout: 15_000 },
      );
      await expect(page.getByTestId('audio-play-button')).toBeVisible({
        timeout: 15_000,
      });

      await setOffline(context, false);
    });
  });
});
