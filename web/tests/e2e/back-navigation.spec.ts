/**
 * Header back control: placement and one-step origin.
 *
 * Every page below the catalog list shows the circular back control in place
 * of the logo. Downloads, Settings and catalog settings return to the page
 * they were opened from; a Downloads card's event returns to Downloads; the
 * catalog list is home. Chromium only for the offline part (see offline.spec).
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './helpers/base-test';
import { loginAs } from './helpers/auth';
import {
  FIRST_RECORDING,
  TEST_CATALOG_ID,
  TEST_EVENTS,
  URLS,
} from './helpers/fixtures';
import { waitForPageReady } from './helpers/navigation';
import {
  clearOfflineStorage,
  setOffline,
  waitForOfflineIndicator,
  waitForServiceWorker,
} from './helpers/offline';

async function getEventIdByTitle(
  request: APIRequestContext,
  title: string,
): Promise<number> {
  const params = new URLSearchParams({ search: title, limit: '50' });
  const response = await request.get(`/api/catalogs/${TEST_CATALOG_ID}/events?${params.toString()}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { events: Array<{ id: number; title: string | null }> };
  const event = body.events.find((item) => item.title === title);
  if (!event) throw new Error(`Seeded event not found: ${title}`);
  return event.id;
}

const headerBack = (page: Page) => page.getByTestId('header-back');
const homeLogo = (page: Page) => page.getByRole('link', { name: 'Besedy home' });

test.describe('Header back navigation', () => {
  // Desktop layout: the catalog settings button and the dropdown user menu
  // are desktop-only, and offline emulation is reliable in Chromium.
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop Chrome only');
  });

  test('Downloads opened from a recording returns to it without replaying its seek', async ({
    page,
  }) => {
    await loginAs(page, 'listener');
    const recording = URLS.recording(FIRST_RECORDING.hash);
    await page.goto(`${recording}?seek=12&end=40&fromSearch=1`);
    await waitForPageReady(page);
    await expect(headerBack(page)).toBeVisible();

    await page.getByTestId('header-downloads').click();
    await expect(page).toHaveURL(
      `/downloads?backTo=${encodeURIComponent(recording)}`,
    );
    // The back control sits in the header in place of the logo, and the page
    // no longer draws its own.
    await expect(headerBack(page)).toHaveAttribute('href', recording);
    await expect(homeLogo(page)).toHaveCount(0);
    await expect(page.getByTestId('downloads-catalog-back')).toHaveCount(0);

    await headerBack(page).click();
    await expect(page).toHaveURL(recording);
  });

  test('Downloads card event goes back to Downloads, then the catalog list, then stops', async ({
    page,
  }) => {
    await loginAs(page, 'listener');
    await clearOfflineStorage(page);
    const eventId = await getEventIdByTitle(page.request, TEST_EVENTS[0].title);
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

    await page.goto('/downloads');
    await waitForPageReady(page);
    // Opened directly: back leads to the catalog.
    await expect(headerBack(page)).toHaveAttribute('href', '/catalog');
    await page.getByRole('link', { name: /open|otevřít/i }).first().click();
    await expect(page).toHaveURL(`${URLS.event(eventId)}?backTo=%2Fdownloads`);
    await expect(headerBack(page)).toHaveAttribute('href', '/downloads');

    await headerBack(page).click();
    await expect(page).toHaveURL('/downloads');
    await expect(headerBack(page)).toHaveAttribute('href', '/catalog');

    await headerBack(page).click();
    await expect(page).toHaveURL(/\/catalog\/[^/?]+/);
    await expect(homeLogo(page)).toBeVisible();
    await expect(headerBack(page)).toHaveCount(0);
  });

  test('Settings returns to the page it was opened from and keeps it on same-page links', async ({
    page,
  }) => {
    await loginAs(page, 'listener');
    const recording = URLS.recording(FIRST_RECORDING.hash);
    await page.goto(recording);
    await waitForPageReady(page);

    await page.getByTestId('user-menu-trigger').filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: /^settings|^nastavení/i }).click();
    await expect(page).toHaveURL(`/settings?backTo=${encodeURIComponent(recording)}`);
    await expect(headerBack(page)).toHaveAttribute('href', recording);

    // The Downloads shortcut from Settings remembers Settings with its origin
    // stripped, and the user menu's Settings item keeps the open page's origin.
    await expect(page.getByTestId('header-downloads')).toHaveAttribute(
      'href',
      '/downloads?backTo=%2Fsettings',
    );
    const settingsItem = page.getByRole('menuitem', { name: /^settings|^nastavení/i });
    await expect(async () => {
      await page.getByTestId('user-menu-trigger').filter({ visible: true }).first().click();
      await expect(settingsItem).toBeVisible({ timeout: 2_000 });
    }).toPass();
    await expect(settingsItem).toHaveAttribute(
      'href',
      `/settings?backTo=${encodeURIComponent(recording)}`,
    );
    await page.keyboard.press('Escape');

    await headerBack(page).click();
    await expect(page).toHaveURL(recording);
  });

  test('catalog settings returns to the page it was opened from', async ({ page }) => {
    await loginAs(page, 'owner');
    const recording = URLS.recording(FIRST_RECORDING.hash);
    await page.goto(recording);
    await waitForPageReady(page);

    const settingsLink = page.locator(`header a[href^="${URLS.catalogSettings}"]`);
    await expect(settingsLink).toHaveAttribute(
      'href',
      `${URLS.catalogSettings}?backTo=${encodeURIComponent(recording)}`,
    );
    await settingsLink.click();
    await expect(headerBack(page)).toHaveAttribute('href', recording);
  });

  test('offline, Downloads returns to a downloaded event but is home after Settings', async ({
    page,
    context,
  }) => {
    await loginAs(page, 'listener');
    await clearOfflineStorage(page);
    const eventId = await getEventIdByTitle(page.request, TEST_EVENTS[0].title);
    const event = URLS.event(eventId);
    await page.goto(event);
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

    // Playwright's offline emulation leaves navigator.onLine true in documents
    // loaded while offline; a real offline browser reports false.
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false });
    });
    await setOffline(context, true);
    await waitForOfflineIndicator(page);

    // A downloaded event opens offline, so Downloads leads back to it.
    await page.getByTestId('offline-indicator').click();
    await expect(page).toHaveURL(`/downloads?backTo=${encodeURIComponent(event)}`);
    await expect(headerBack(page)).toHaveAttribute('href', event, { timeout: 15_000 });

    // Settings cannot open offline, so Downloads opened from it is home.
    await page.goto(URLS.settings);
    await expect(page.getByTestId('offline-unavailable')).toBeVisible({ timeout: 15_000 });
    await waitForOfflineIndicator(page, 15_000);
    await page.getByTestId('offline-indicator').click();
    await expect(page).toHaveURL('/downloads?backTo=%2Fsettings');
    await expect(homeLogo(page)).toBeVisible({ timeout: 15_000 });
    await expect(headerBack(page)).toHaveCount(0);

    await setOffline(context, false);
  });
});
