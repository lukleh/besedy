/**
 * E2E tests for the notification system.
 *
 * Tests cover:
 * - Notification bell badge display
 * - Notification popover interactions
 * - Mark as read functionality
 * - Navigation from notifications
 * - Push notification settings
 */

import { test, expect } from "./helpers/base-test";
import type { APIRequestContext, Page } from "@playwright/test";
import { clearEventNotificationsForRole, loginAs, resetSeededNotifications } from "./helpers/auth";
import { waitForPageReady } from "./helpers/navigation";
import { TEST_CATALOG_ID, TEST_EVENTS, URLS } from "./helpers/fixtures";

const NOTIFICATIONS_LABEL = /notifications|oznámení/i;
const EMPTY_NOTIFICATIONS_LABEL = /no notifications|žádná oznámení/i;
const MARK_ALL_READ_LABEL = /mark all read|mark all as read|označit vše jako přečtené/i;
const SETTINGS_HEADING_LABEL = /settings|nastavení|notification settings|nastavení oznámení/i;
const PUSH_NOTIFICATIONS_LABEL = /push notifications|push oznámení/i;
const ABOUT_NOTIFICATIONS_LABEL = /about notifications|o oznámeních/i;
const LABS_SECTION_LABEL = /besedy labs/i;
const LABS_TOGGLE_LABEL = /enable besedy labs|zapnout besedy labs/i;
const BACK_TO_CATALOG_LABEL = /back to catalog|zpět do katalogu/i;
const PUSH_UNAVAILABLE_LABEL =
  /not supported|nepodporováno|permission denied|oprávnění.*zamítnuto|notifications blocked|zablokov/i;

function getBellButton(page: Page) {
  return page.getByRole("button", { name: NOTIFICATIONS_LABEL }).first();
}

async function getUnreadBadgeCount(page: Page): Promise<number> {
  const badge = getBellButton(page).locator('[data-testid="notification-badge"]').first();
  const count = await badge.count();
  if (count === 0) return 0;

  const text = (await badge.textContent())?.trim() ?? "";
  if (text === "99+") return 99;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function expectPushCapabilityState(page: Page): Promise<"toggle" | "unavailable"> {
  const toggle = page.locator("#push-toggle");
  if (await toggle.count()) {
    await expect(toggle).toBeVisible({ timeout: 5000 });
    return "toggle";
  }

  await expect(page.getByText(PUSH_UNAVAILABLE_LABEL).first()).toBeVisible({
    timeout: 5000,
  });
  return "unavailable";
}

interface EventListItem {
  id: number;
  title: string | null;
}

async function getEventIdByTitle(
  request: APIRequestContext,
  title: string
): Promise<number> {
  const params = new URLSearchParams({
    group: TEST_CATALOG_ID,
    search: title,
    limit: "50",
  });
  const response = await request.get(`/api/catalog-events?${params.toString()}`);
  expect(response.ok()).toBeTruthy();

  const body = (await response.json()) as { events: EventListItem[] };
  const event = body.events.find((item) => item.title === title);
  if (!event) {
    throw new Error(`Seeded event not found by title: ${title}`);
  }
  return event.id;
}

test.describe("Notifications", () => {
  test.describe("Notification Bell - Basic UI", () => {
    test("bell icon is visible in header for authenticated users", async ({ page }) => {
      await loginAs(page, "viewer");
      await waitForPageReady(page);

      // Bell button should be visible in the header
      const bellButton = getBellButton(page);
      await expect(bellButton).toBeVisible({ timeout: 10000 });
    });

    test("popover opens when bell is clicked", async ({ page }) => {
      await loginAs(page, "viewer");
      await waitForPageReady(page);

      // Click bell
      const bellButton = getBellButton(page);
      await bellButton.click();

      // Popover should open with notifications heading. On mobile the
      // drawer renders both an outer DrawerTitle (h2) and an inner popover
      // heading, so match any visible heading named "Notifications".
      const popoverHeading = page
        .getByRole("heading", { name: NOTIFICATIONS_LABEL })
        .filter({ visible: true })
        .first();
      await expect(popoverHeading).toBeVisible({ timeout: 5000 });
    });

    test("shows empty state when no notifications", async ({ page }) => {
      // Event publishing fans notifications out to every catalog-access
      // user, including the viewer role. Earlier tests in the run may have
      // released an event, so scrub the viewer's notifications first.
      await clearEventNotificationsForRole("viewer");
      await loginAs(page, "viewer");
      await waitForPageReady(page);

      // Click bell
      const bellButton = getBellButton(page);
      await bellButton.click();

      // Should show empty state message
      const emptyMessage = page.getByText(EMPTY_NOTIFICATIONS_LABEL);
      await expect(emptyMessage).toBeVisible({ timeout: 5000 });
    });

    test("links to settings page from popover", async ({ page }) => {
      await loginAs(page, "viewer");
      await waitForPageReady(page);

      // Click bell
      const bellButton = getBellButton(page);
      await bellButton.click();

      // Find and click settings link
      const settingsLink = page.getByRole("link", { name: /settings/i }).first();
      await expect(settingsLink).toBeVisible({ timeout: 5000 });
      await settingsLink.click();

      // Should navigate to settings
      await expect(page).toHaveURL(/\/settings/);
    });
  });

  test.describe("Notification Display - With Seeded Data", () => {
    test.describe.configure({ mode: "serial" });

    /**
     * Tests using superadmin who has seeded notifications:
     * - 2 unread notifications for released events
     */
    test.beforeEach(async () => {
      await resetSeededNotifications("superadmin");
    });

    test("shows unread badge count for users with notifications", async ({ page }) => {
      await loginAs(page, "superadmin");
      await waitForPageReady(page);

      // Bell button should show badge with unread count
      const bellButton = getBellButton(page);
      await expect(bellButton).toBeVisible({ timeout: 10000 });

      // Badge should show "2" for the 2 unread notifications
      await expect.poll(() => getUnreadBadgeCount(page), { timeout: 5000 }).toBe(2);
    });

    test("displays notification list with event titles", async ({ page }) => {
      await loginAs(page, "superadmin");
      await waitForPageReady(page);

      // Open notifications popover
      const bellButton = getBellButton(page);
      await bellButton.click();

      // Should show notification items with event titles
      const firstEvent = TEST_EVENTS[0].title;
      const secondEvent = TEST_EVENTS[2].title;

      await expect(page.getByText(firstEvent)).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(secondEvent)).toBeVisible({ timeout: 5000 });
    });

    test("clicking notification navigates to event page", async ({ page }) => {
      await loginAs(page, "superadmin");
      await waitForPageReady(page);

      // Open notifications popover
      const bellButton = getBellButton(page);
      await bellButton.click();

      // Click on the first notification
      const firstEvent = TEST_EVENTS[0].title;
      const eventId = await getEventIdByTitle(page.request, firstEvent);
      const notificationLink = page.getByRole("link", { name: new RegExp(firstEvent) });
      await notificationLink.click();

      // Should navigate to the event page
      const expectedUrl = URLS.event(eventId);
      await expect(page).toHaveURL(new RegExp(expectedUrl));
    });

    test("mark all as read button clears unread count", async ({ page }) => {
      await loginAs(page, "superadmin");
      await waitForPageReady(page);

      // Open notifications popover
      const bellButton = getBellButton(page);
      await bellButton.click();

      // Click "Mark all as read" button
      const markAllButton = page.getByRole("button", { name: MARK_ALL_READ_LABEL });
      await expect(markAllButton).toBeVisible({ timeout: 5000 });
      await markAllButton.click();

      // Badge should disappear after mutation settles
      await expect.poll(() => getUnreadBadgeCount(page), { timeout: 10000 }).toBe(0);
    });

    test("clicking individual notification marks it as read", async ({ page }) => {
      await loginAs(page, "superadmin");
      await waitForPageReady(page);

      // Ensure deterministic unread state before action
      const initialUnread = await getUnreadBadgeCount(page);
      expect(initialUnread).toBeGreaterThan(0);

      // Open notifications popover
      const bellButton = getBellButton(page);
      await bellButton.click();

      // Click on a notification (this should mark it as read)
      const firstEvent = TEST_EVENTS[0].title;
      const notificationLink = page.getByRole("link", { name: new RegExp(firstEvent) });
      await notificationLink.click();

      // Navigate back
      await page.goBack();
      await waitForPageReady(page);

      // Badge count should decrease after opening one notification
      await expect
        .poll(() => getUnreadBadgeCount(page), { timeout: 10000 })
        .toBeLessThan(initialUnread);
    });
  });

  test.describe("Notification Settings Page", () => {
    test("settings page loads correctly", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto("/settings");
      await waitForPageReady(page);

      // Page title should be visible
      const pageTitle = page.getByRole("heading", { name: SETTINGS_HEADING_LABEL });
      await expect(pageTitle).toBeVisible({ timeout: 10000 });
    });

    test("shows push notification toggle", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto("/settings");
      await waitForPageReady(page);

      // Push notifications section should be visible
      const pushSection = page.getByText(PUSH_NOTIFICATIONS_LABEL).first();
      await expect(pushSection).toBeVisible({ timeout: 10000 });

      // Depending on browser permission/capabilities we get a switch or unavailable state
      await expectPushCapabilityState(page);
    });

    test("shows about section", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto("/settings");
      await waitForPageReady(page);

      // About section should be visible
      const aboutHeading = page.getByRole("heading", { name: ABOUT_NOTIFICATIONS_LABEL });
      await expect(aboutHeading).toBeVisible({ timeout: 10000 });
    });

    test("shows Besedy Labs section and toggle", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto("/settings");
      await waitForPageReady(page);

      await expect(page.getByRole("heading", { name: LABS_SECTION_LABEL })).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByLabel(LABS_TOGGLE_LABEL)).toBeVisible({ timeout: 10000 });
    });

    test("back link returns to catalog", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto("/settings");
      await waitForPageReady(page);

      // Find and click back link
      const backLink = page.getByRole("link", { name: BACK_TO_CATALOG_LABEL });
      await expect(backLink).toBeVisible({ timeout: 10000 });
      await backLink.click();

      // Should navigate to catalog
      await expect(page).toHaveURL(/\/catalog/);
    });

    test("toggle shows permission state when clicked", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto("/settings");
      await waitForPageReady(page);

      const capabilityState = await expectPushCapabilityState(page);
      if (capabilityState === "unavailable") {
        return;
      }

      const toggle = page.locator("#push-toggle");

      // Click the toggle - in test environment, this should trigger permission check
      // The exact behavior depends on browser permissions, but we can check for state change
      await toggle.click();

      // Should either show a toast (for success/error) or update the toggle state
      // Wait a moment for async operation
      await page.waitForTimeout(1000);

      // The toggle should still be in a valid state (not broken)
      await expect(toggle).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Push Notification Subscription", () => {
    /**
     * Note: Full push notification testing requires browser permission handling
     * which is complex in E2E tests. These tests verify the UI flow works correctly.
     */

    test("shows a valid capability state", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto("/settings");
      await waitForPageReady(page);

      await expectPushCapabilityState(page);
    });

    test("toggle remains stable after click when available", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto("/settings");
      await waitForPageReady(page);

      const capabilityState = await expectPushCapabilityState(page);
      if (capabilityState === "unavailable") {
        return;
      }

      const toggle = page.locator("#push-toggle");
      await toggle.click();
      await page.waitForTimeout(1000);
      await expect(toggle).toBeVisible({ timeout: 5000 });
    });
  });
});
