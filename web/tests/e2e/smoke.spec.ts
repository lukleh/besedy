/**
 * Smoke tests for critical user flows.
 *
 * These tests verify the most essential functionality works.
 * Run with: npm run test:e2e:smoke
 *
 * @tags @smoke
 */

import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { URLS } from "./helpers/fixtures";
import {
  openFirstPlayableCatalogItem,
  waitForAudioState,
  waitForPageReady,
} from "./helpers/navigation";

test.describe("Smoke Tests @smoke", () => {
  test("listener can sign in and view catalog", async ({ page }) => {
    await loginAs(page, "listener");
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    // Catalog landing page loads with visible content.
    await expect(page).toHaveURL(/\/catalog\//);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByText(/\d+ (recordings|events)/i).first()).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page
        .locator(
          "[data-testid='recording-card'], [data-testid^='event-card-'], [data-testid='recording-row'], table tbody tr"
        )
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 10000 });
  });

  test("listener can open a catalog item and play audio", async ({ page }) => {
    await loginAs(page, "listener");
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    const openedRoute = await openFirstPlayableCatalogItem(page);
    await waitForPageReady(page);
    await expect(page).toHaveURL(/\/catalog\/[^/]+\/(recording|event)\//);

    // Listener should reach a playable recording surface from the catalog UI.
    const playButton = page.getByTestId("audio-play-button").first();
    await expect(playButton).toBeVisible({ timeout: 10000 });

    const audioResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/catalogs/") &&
        response.url().includes("/recordings/") &&
        response.url().includes("/audio"),
      { timeout: 5000 }
    ).catch(() => null);

    await playButton.click();
    const [audioResponse, isPlaying] = await Promise.all([
      audioResponsePromise,
      waitForAudioState(page, "playing", 10000),
    ]);
    if (audioResponse) {
      expect([200, 206]).toContain(audioResponse.status());
    }
    expect(isPlaying).toBe(true);

    await playButton.click();
    expect(await waitForAudioState(page, "paused", 5000)).toBe(true);

    // Seek via the progress slider. The role=slider element is the Radix
    // thumb — clicking its bounding box doesn't translate to a seek, so
    // drive it via keyboard: focus + End jumps to the track's max (the
    // recording duration), which is a large-enough delta to verify the
    // seek actually took effect. This exercises the #2 most-used player
    // interaction after play/pause.
    const progressSlider = page.getByRole("slider", { name: /playback progress/i }).first();
    await expect(progressSlider).toBeVisible({ timeout: 5000 });
    const audioElement = page.locator("audio").first();
    const priorTime = await audioElement.evaluate(
      (audio: HTMLAudioElement) => audio.currentTime
    );
    await progressSlider.focus();
    await page.keyboard.press("End");
    // currentTime settles asynchronously after the slider value change
    // propagates through onValueChange → audio.currentTime.
    await expect
      .poll(
        async () =>
          await audioElement.evaluate((audio: HTMLAudioElement) => audio.currentTime),
        { timeout: 5000 }
      )
      .toBeGreaterThan(priorTime + 1);

    // Toggle mute and verify the click flips the button's accessible name
    // between "Mute" and "Unmute". We don't assert on `audio.volume` here
    // because WebKit (iPhone 14 in Playwright) treats HTMLMediaElement
    // volume as read-only — the app still updates its React state, so the
    // label is the viewport-independent signal.
    const muteButton = page.getByRole("button", { name: /^mute$/i }).first();
    await expect(muteButton).toBeVisible({ timeout: 5000 });
    await muteButton.click();
    await expect(
      page.getByRole("button", { name: /^unmute$/i }).first()
    ).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: /^unmute$/i }).first().click();
    await expect(
      page.getByRole("button", { name: /^mute$/i }).first()
    ).toBeVisible({ timeout: 5000 });

    // Listener restrictions stay in force even on the playable surface.
    await expect(page.getByRole("heading", { name: /transcript/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /download/i })).toHaveCount(0);

    // Keep a direct signal in the failure output about which UI route was used.
    expect(["recording", "event"]).toContain(openedRoute);
  });

  test("user can start radio mode", async ({ page }) => {
    await loginAs(page, "viewer");
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    // Start radio via header button
    const startButton = page.locator("header").getByRole("button", { name: /start radio/i });
    await expect(startButton).toBeVisible({ timeout: 10000 });
    await startButton.click();

    // Radio controls should appear (indicates playback started)
    const skipButton = page.getByRole("button", { name: /skip to next/i });
    await expect(skipButton).toBeVisible({ timeout: 15000 });

    // Stop radio
    const stopButton = page.locator("header").getByRole("button", { name: /stop radio/i });
    await stopButton.click({ force: true });

    // Start button should return
    await expect(startButton).toBeVisible({ timeout: 5000 });
  });
});
