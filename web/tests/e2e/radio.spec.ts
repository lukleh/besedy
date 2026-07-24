/**
 * Radio Mode E2E tests.
 *
 * Tests the continuous playback "radio" feature that plays the primary
 * recording of each released event in a catalog, in sequence.
 */

import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { URLS, TEST_CATALOG_ID } from "./helpers/fixtures";
import { waitForPageReady } from "./helpers/navigation";

test.describe("Radio Mode", () => {
  test.describe("Radio Button", () => {
    test("radio button is visible in header for authenticated user", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.catalog);
      await waitForPageReady(page);

      // Radio button should be visible with "Start radio" label
      const radioButton = page.getByRole("button", { name: /start radio/i });
      await expect(radioButton).toBeVisible({ timeout: 10000 });
    });

    test("radio button is not visible on auth pages", async ({ page }) => {
      // Go to signin page (not authenticated)
      await page.goto(URLS.signIn);
      await waitForPageReady(page);

      // Radio button should not be visible
      const radioButton = page.getByRole("button", { name: /start radio|stop radio/i });
      await expect(radioButton).not.toBeVisible();
    });
  });

  test.describe("Radio Playback", () => {
    test("can start and stop radio mode", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.catalog);
      await waitForPageReady(page);

      // Start radio - button is in header
      const startButton = page.locator("header").getByRole("button", { name: /start radio/i });
      await expect(startButton).toBeVisible({ timeout: 10000 });
      await startButton.click();

      // Radio banner should appear with track info
      // Wait for radio banner controls to appear (banner has Skip/Pause buttons)
      const skipButton = page.getByRole("button", { name: /skip to next/i });
      await expect(skipButton).toBeVisible({ timeout: 15000 });

      // Header button should now show "Stop radio"
      const headerStopButton = page.locator("header").getByRole("button", { name: /stop radio/i });
      await expect(headerStopButton).toBeVisible();

      // Stop radio via header button (use force to avoid stability issues during playback)
      await headerStopButton.click({ force: true });

      // Radio banner should disappear, start button returns
      await expect(startButton).toBeVisible({ timeout: 5000 });
    });

    test("radio banner shows playback controls", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.catalog);
      await waitForPageReady(page);

      // Start radio via header button
      const startButton = page.locator("header").getByRole("button", { name: /start radio/i });
      await startButton.click();

      // Wait for radio banner to appear by checking for its unique controls
      // The banner has Skip, Pause, and Stop buttons outside the header
      const skipButton = page.getByRole("button", { name: /skip to next/i });
      const pauseButton = page.getByRole("button", { name: /^pause$/i });

      // Controls should be visible (indicates banner is showing)
      await expect(skipButton).toBeVisible({ timeout: 15000 });
      await expect(pauseButton).toBeVisible({ timeout: 5000 });

      // Clean up - stop radio via header button (use force to avoid stability issues)
      const headerStopButton = page.locator("header").getByRole("button", { name: /stop radio/i });
      await headerStopButton.click({ force: true });
    });

    test("can skip to next track", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.catalog);
      await waitForPageReady(page);

      // Start radio via header button
      const startButton = page.locator("header").getByRole("button", { name: /start radio/i });
      await startButton.click();

      // Wait for radio banner to appear (skip button indicates it's visible)
      const skipButton = page.getByRole("button", { name: /skip to next/i });
      await expect(skipButton).toBeVisible({ timeout: 15000 });

      // Click skip button
      await skipButton.click();

      // Wait for next track to load (skip button should still be visible)
      await page.waitForTimeout(2000);
      await expect(skipButton).toBeVisible();

      // Clean up - stop radio via header button (use force to avoid stability issues)
      const headerStopButton = page.locator("header").getByRole("button", { name: /stop radio/i });
      await headerStopButton.click({ force: true });
    });

    test("clicking the radio banner opens the event page and hands off", async ({ page }) => {
      await loginAs(page, "viewer");
      await page.goto(URLS.catalog);
      await waitForPageReady(page);

      const startButton = page
        .locator("header")
        .getByRole("button", { name: /start radio/i });
      await startButton.click();

      const skipButton = page.getByRole("button", { name: /skip to next/i });
      await expect(skipButton).toBeVisible({ timeout: 15000 });

      // Click the banner's track info: it navigates to the event page and hands
      // off playback (the radio plays an event's primary, so the event page it
      // opens shows that same primary).
      await page.getByTestId("radio-banner-title").click();

      await page.waitForURL(/\/catalog\/[^/]+\/event\/\d+\?fromRadio=true/, {
        timeout: 10000,
      });

      // Handoff: the radio went inactive (banner gone, header offers Start again).
      await expect(
        page.locator("header").getByRole("button", { name: /start radio/i })
      ).toBeVisible({ timeout: 10000 });
      await expect(skipButton).not.toBeVisible();
    });
  });

  test.describe("Random Track API", () => {
    test("returns random track from catalog", async ({ page }) => {
      await loginAs(page, "viewer");

      // Call the random-event API directly
      const response = await page.request.get(
        `/api/catalogs/${TEST_CATALOG_ID}/random-event`
      );

      expect(response.status()).toBe(200);
      const body = await response.json();

      // Should return a track with expected fields
      expect(body).toHaveProperty("hash");
      expect(body).toHaveProperty("title");
      expect(body).toHaveProperty("total");
      expect(body.hash).toBeTruthy();
      expect(body.total).toBeGreaterThan(0);

      // Event-oriented: the radio plays an event's primary recording, so the
      // response carries the event id and its (event-sourced) metadata.
      expect(typeof body.eventId).toBe("number");
      expect(body.eventId).toBeGreaterThan(0);
      expect(typeof body.dateYear).toBe("number");
      expect(body.locationName).toBeTruthy();
    });

    test("respects exclude parameter", async ({ page }) => {
      await loginAs(page, "viewer");

      // Get a track first
      const firstResponse = await page.request.get(
        `/api/catalogs/${TEST_CATALOG_ID}/random-event`
      );
      const firstTrack = await firstResponse.json();

      // Request again excluding that track
      const secondResponse = await page.request.get(
        `/api/catalogs/${TEST_CATALOG_ID}/random-event?exclude=${firstTrack.hash}`
      );
      const secondTrack = await secondResponse.json();

      expect(secondResponse.status()).toBe(200);
      // With enough tracks, should get a different one
      // (Note: might get same track if only one exists, so we just verify the API works)
      expect(secondTrack.hash).toBeTruthy();
    });

    test("exclude parameter filters out specified tracks", async ({ page }) => {
      await loginAs(page, "viewer");

      // Get first track
      const firstResponse = await page.request.get(
        `/api/catalogs/${TEST_CATALOG_ID}/random-event`
      );
      const firstTrack = await firstResponse.json();

      expect(firstResponse.status()).toBe(200);
      expect(firstTrack.hash).toBeTruthy();
      expect(firstTrack.total).toBeGreaterThan(0);

      // Request with exclude - API should accept it (though result may vary)
      const excludeResponse = await page.request.get(
        `/api/catalogs/${TEST_CATALOG_ID}/random-event?exclude=${firstTrack.hash}`
      );
      const excludeTrack = await excludeResponse.json();

      expect(excludeResponse.status()).toBe(200);
      expect(excludeTrack.hash).toBeTruthy();

      // If there are multiple events, the result should be a different primary
      // (if only one event exists, historyReset is true and the same primary returns)
      if (firstTrack.total > 1) {
        expect(excludeTrack.hash).not.toBe(firstTrack.hash);
      }
    });

    test("returns 403 for unauthorized user", async ({ page }) => {
      await loginAs(page, "noaccess");

      const response = await page.request.get(
        `/api/catalogs/${TEST_CATALOG_ID}/random-event`
      );

      expect(response.status()).toBe(403);
    });
  });

  test.describe("Catalog Status API", () => {
    test("returns catalog status for authorized user", async ({ page }) => {
      await loginAs(page, "viewer");

      const response = await page.request.get(
        `/api/catalogs/${TEST_CATALOG_ID}/status`
      );

      expect(response.status()).toBe(200);
      const body = await response.json();

      expect(body).toHaveProperty("catalogId", TEST_CATALOG_ID);
      expect(body).toHaveProperty("lastModifiedAt");
      expect(body).toHaveProperty("curatedEntries");
      expect(typeof body.curatedEntries).toBe("number");
    });

    test("returns 403 for unauthorized user", async ({ page }) => {
      await loginAs(page, "noaccess");

      const response = await page.request.get(
        `/api/catalogs/${TEST_CATALOG_ID}/status`
      );

      expect(response.status()).toBe(403);
    });

    test("returns error for non-existent catalog", async ({ page }) => {
      await loginAs(page, "viewer");

      // Use a valid timestamp format that doesn't exist
      const response = await page.request.get(
        `/api/catalogs/19991231_235959/status`
      );

      // Should return 404 (not found) or 403 (forbidden - user has no access)
      expect([403, 404]).toContain(response.status());
    });
  });
});
