import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from './helpers/base-test';
import { loginAs } from './helpers/auth';
import { URLS } from './helpers/fixtures';
import { waitForPageReady } from './helpers/navigation';
import { waitForServiceWorker } from './helpers/offline';

test.describe('Service worker updates', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Service workers require Chromium',
  );

  test('installs build B, activates it from the banner, and reloads', async ({
    context,
    page,
  }) => {
    const workerSource = readFileSync(
      resolve(process.cwd(), 'public/sw.js'),
      'utf8',
    );
    let servedOldWorker = false;

    await context.route('**/sw.js', async (route) => {
      if (servedOldWorker) {
        await route.continue();
        return;
      }

      servedOldWorker = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `${workerSource}\n// E2E web version: build-a\n`,
      });
    });

    await loginAs(page, 'viewer');
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    if (
      !(await page.evaluate(() => navigator.serviceWorker.controller !== null))
    ) {
      await page.reload();
      await waitForPageReady(page);
    }
    await waitForServiceWorker(page);

    await context.unroute('**/sw.js');
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });

    await expect
      .poll(() =>
        page.evaluate(async () =>
          Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
        ),
      )
      .toBe(true);

    await expect(
      page.getByText(/Update available|Aktualizace dostupná/i).first(),
    ).toBeVisible();

    const reloaded = page.waitForEvent('load');
    await page
      .getByRole('button', {
        name: /Refresh to update|Obnovit pro aktualizaci/i,
      })
      .click();
    await reloaded;
    await waitForPageReady(page);

    await expect
      .poll(() =>
        page.evaluate(async () =>
          Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
        ),
      )
      .toBe(false);
    await expect(
      page.getByText(/Update available|Aktualizace dostupná/i),
    ).toHaveCount(0);
  });
});
