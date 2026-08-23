import { test, expect } from '../helpers/base-test';
import { loginAs } from '../helpers/auth';
import {
  TEST_AUDIO_FILES,
  TEST_CATALOG_ID,
  TEST_EVENTS,
  URLS,
} from '../helpers/fixtures';
import { waitForPageReady } from '../helpers/navigation';

interface EventItem {
  id: number;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
}

test.describe('Mobile event listening flow', () => {
  test('listener can sort events, see progress, and move through the event order', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === 'Desktop Chrome',
      'This flow exercises the mobile event controls',
    );
    await loginAs(page, 'listener');
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    const eventsResponse = await page.request.get(
      `/api/catalog-events?group=${TEST_CATALOG_ID}&limit=2&sort=date&dir=desc`,
    );
    expect(eventsResponse.ok()).toBeTruthy();
    const eventList = (await eventsResponse.json()) as {
      events: EventItem[];
    };
    expect(eventList.events).toHaveLength(2);

    const [newest, oldest] = eventList.events;
    const archivePrimaryHash = TEST_AUDIO_FILES.find(
      (file) => file.shortHash === TEST_EVENTS[2].primaryRecording,
    )?.hash;
    expect(archivePrimaryHash).toBeTruthy();

    const progressStatus = await page.evaluate(
      async ({ catalogId, hash }) => {
        const response = await fetch(
          `/api/catalogs/${catalogId}/recordings/${hash}/progress`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionSec: 60, durationSec: 120 }),
          },
        );
        return response.status;
      },
      { catalogId: TEST_CATALOG_ID, hash: archivePrimaryHash! },
    );
    expect(progressStatus).toBe(200);

    await page.reload();
    await waitForPageReady(page);

    const sortButton = page.getByTestId('mobile-event-date-sort');
    await expect(sortButton).toBeVisible();
    await expect(sortButton).toHaveAccessibleName(/newest first/i);
    const newestCard = page.getByTestId(`event-card-${newest.id}`);
    await expect(newestCard).toBeVisible();
    await expect(newestCard.getByLabel('50% listened')).toBeVisible();

    const listScreenshot = testInfo.outputPath('events-mobile-progress.png');
    await page.screenshot({ path: listScreenshot, fullPage: true });
    await testInfo.attach('Events mobile list with progress', {
      path: listScreenshot,
      contentType: 'image/png',
    });

    await sortButton.click();
    await expect(sortButton).toHaveAccessibleName(/oldest first/i);
    const eventCards = page.locator('[data-testid^="event-card-"]');
    await expect(eventCards.first()).toHaveAttribute(
      'data-testid',
      `event-card-${oldest.id}`,
    );

    await eventCards.first().click();
    await expect(page).toHaveURL(URLS.event(oldest.id));
    const eventNavigation = page.getByTestId('event-sequence-navigation');
    await expect(eventNavigation).toBeVisible();
    await expect(eventNavigation.getByText('1 of 2')).toBeVisible();
    await expect(
      eventNavigation.getByRole('button', { name: 'Previous' }),
    ).toBeDisabled();
    await expect(
      eventNavigation.getByRole('button', { name: 'Next' }),
    ).toBeEnabled();

    const detailScreenshot = testInfo.outputPath('event-mobile-navigation.png');
    await page.screenshot({ path: detailScreenshot, fullPage: true });
    await testInfo.attach('Event mobile previous and next', {
      path: detailScreenshot,
      contentType: 'image/png',
    });

    await eventNavigation.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(URLS.event(newest.id));
    await expect(
      page.getByTestId('event-sequence-navigation').getByText('2 of 2'),
    ).toBeVisible();
    await expect(
      page
        .getByTestId('event-sequence-navigation')
        .getByRole('button', { name: 'Previous' }),
    ).toBeEnabled();
  });
});
