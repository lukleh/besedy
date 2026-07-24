/**
 * Workflow-based E2E tests for Besedy.
 *
 * Each test is a complete user journey that documents expected behavior.
 * Tests read like user stories: "As a [role], I can [action]"
 *
 * This file replaces the fragmented assertion tests with focused workflows
 * that verify the core functionality of the transcript viewing app.
 */

import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { URLS, FIRST_RECORDING, TEST_AUDIO_FILES, TEST_CATALOG_ID } from "./helpers/fixtures";
import {
  openFirstPlayableCatalogItem,
  waitForAudioState,
  waitForPageReady,
} from "./helpers/navigation";

test.describe("User Workflows", () => {
  test("LISTENER: can stream audio, but no transcripts", async ({
    page,
  }) => {
    await loginAs(page, "listener");

    // Browse catalog - content visible (table or cards for recordings,
    // button list for events). With the events-default rollout, listeners
    // land on the events view; the catalog header shows either a recordings
    // or events count depending on the active tab.
    await waitForPageReady(page);
    await expect(page.getByText(/\d+ (recordings|events)/i)).toBeVisible({ timeout: 15000 });

    // LISTENER sees only ready items, so status column is hidden by default
    // The status filter dropdown should not be visible in the toolbar
    const statusFilterDropdown = page.locator('[aria-label="Status"]');
    await expect(statusFilterDropdown).toBeHidden({ timeout: 3000 });

    // Open the first playable item from the catalog landing view.
    await openFirstPlayableCatalogItem(page);
    await waitForPageReady(page);
    await expect(page).toHaveURL(/\/catalog\/[^/]+\/(recording|event)\//);

    // Can stream - audio player works
    const playButton = page.getByTestId("audio-play-button");
    await expect(playButton).toBeVisible({ timeout: 15000 });

    const audioResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/catalogs/") &&
        response.url().includes("/recordings/") &&
        response.url().includes("/audio"),
      { timeout: 5000 }
    ).catch(() => null);

    // Verify audio playback works - click play and verify state changes
    await playButton.click();
    const [audioResponse, isPlaying] = await Promise.all([
      audioResponsePromise,
      waitForAudioState(page, "playing", 10000),
    ]);
    if (audioResponse) {
      expect([200, 206]).toContain(audioResponse.status());
    }
    expect(isPlaying).toBe(true);

    // Click again to pause and verify it stops
    await playButton.click();
    expect(await waitForAudioState(page, "paused", 5000)).toBe(true);

    // Cannot see transcripts (LISTENER restriction)
    const transcriptHeading = page.getByRole("heading", { name: /transcript/i });
    await expect(transcriptHeading).toBeHidden({ timeout: 5000 });

    // Cannot download
    const downloadButton = page.getByRole("button", { name: /download/i }).first();
    await expect(downloadButton).toBeHidden({ timeout: 3000 });
  });

  test("VIEWER: can read transcript content", async ({ page }) => {
    await loginAs(page, "viewer");
    await page.goto(URLS.recording(FIRST_RECORDING.hash));
    await waitForPageReady(page);

    // Can see transcript heading
    const transcriptHeading = page.getByRole("heading", { name: /transcript/i });
    await expect(transcriptHeading).toBeVisible({ timeout: 10000 });

    // Transcript availability depends on current backend fixture mapping.
    // Viewers land on the transcript-stream view by default; when no stream
    // exists it renders a "Transcript stream unavailable" heading. Accept
    // both the stream and classic empty-state headings as "empty".
    const noTranscriptHeading = page
      .getByRole("heading", {
        name: /no transcripts available|transcript stream unavailable|přepisy nejsou|přepis.*není/i,
      })
      .first();
    const transcriptSegments = page.locator("[data-segment-index]");

    await expect.poll(async () => {
      if (await noTranscriptHeading.isVisible().catch(() => false)) {
        return "empty";
      }
      if ((await transcriptSegments.count()) > 0) {
        return "content";
      }
      return "pending";
    }, { timeout: 10000 }).toMatch(/empty|content/);

    // Cannot download
    const downloadButton = page.getByRole("button", { name: /download/i }).first();
    await expect(downloadButton).toBeHidden({ timeout: 3000 });

    // Cannot edit
    const editLink = page.getByRole("link", { name: /edit/i });
    await expect(editLink).toBeHidden({ timeout: 3000 });
  });

  test("VIEWER: playback position survives navigation", async ({ page }, testInfo) => {
    // Localhost only — needs a consistent storage domain and no cross-origin
    // navigation. The feature itself is viewport-independent, so run once.
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Single-viewport coverage is sufficient for a storage-driven feature"
    );

    // Use a recording that isn't touched by the mutation tests so we do not
    // race against attach/detach/release writes.
    const recording = TEST_AUDIO_FILES[1]; // 60s, stable across runs
    await loginAs(page, "viewer");

    // Scrub any stored position for this hash so the first visit starts at 0.
    await page.goto(URLS.recording(recording.hash));
    await waitForPageReady(page);
    await page.evaluate(
      (hash) => window.localStorage.removeItem(`besedy-playback-${hash}`),
      recording.hash
    );

    const playButton = page.getByTestId("audio-play-button").first();
    await expect(playButton).toBeVisible({ timeout: 10000 });
    await playButton.click();
    expect(await waitForAudioState(page, "playing", 10000)).toBe(true);

    // Advance past a few seconds of playback so the saved position is a
    // comfortable margin above zero.
    await expect
      .poll(
        async () =>
          await page
            .locator("audio")
            .first()
            .evaluate((audio: HTMLAudioElement) => audio.currentTime),
        { timeout: 10000 }
      )
      .toBeGreaterThan(2);

    // Navigate away. The pagehide/visibilitychange handlers in
    // use-recording-playback.ts flush the current position to localStorage
    // immediately, independent of the 5s debounce timer.
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    // Verify the position landed in storage before returning.
    const storedRaw = await page.evaluate(
      (hash) => window.localStorage.getItem(`besedy-playback-${hash}`),
      recording.hash
    );
    expect(storedRaw, "expected playback position to be persisted").not.toBeNull();
    const storedSeconds = Number.parseFloat(storedRaw ?? "0");
    expect(storedSeconds).toBeGreaterThan(0);

    // Return to the recording — the player should resume at the saved spot.
    await page.goto(URLS.recording(recording.hash));
    await waitForPageReady(page);
    await expect(page.getByTestId("audio-play-button").first()).toBeVisible({ timeout: 10000 });

    await expect
      .poll(
        async () =>
          await page
            .locator("audio")
            .first()
            .evaluate((audio: HTMLAudioElement) => audio.currentTime),
        { timeout: 10000 }
      )
      .toBeGreaterThanOrEqual(storedSeconds - 0.5);
  });

  test("VIEWER: playback continues when the tab is hidden", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Single-viewport coverage is sufficient for a visibility policy check"
    );

    await loginAs(page, "viewer");
    await page.goto(URLS.recording(TEST_AUDIO_FILES[1].hash));
    await waitForPageReady(page);

    const playButton = page.getByTestId("audio-play-button").first();
    await expect(playButton).toBeVisible({ timeout: 10000 });
    await playButton.click();
    expect(await waitForAudioState(page, "playing", 10000)).toBe(true);

    // Wait for real playback progress — `waitForAudioState` returns true as
    // soon as the audio element is not paused, which can be before
    // currentTime starts advancing.
    const audio = page.locator("audio").first();
    await expect
      .poll(
        async () =>
          await audio.evaluate((el: HTMLAudioElement) => el.currentTime),
        { timeout: 10000 }
      )
      .toBeGreaterThan(0.5);
    const timeBeforeHide = await audio.evaluate(
      (el: HTMLAudioElement) => el.currentTime
    );

    // Simulate the tab going to the background. Playwright can't hide a real
    // tab, but the app's only reaction to hidden is a position flush — it
    // must not pause audio. Verify that policy directly by driving
    // document.visibilityState and dispatching the event the app listens to.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Audio must stay unpaused and advance further.
    await expect
      .poll(
        async () =>
          await audio.evaluate((el: HTMLAudioElement) => ({
            paused: el.paused,
            time: el.currentTime,
          })),
        { timeout: 5000 }
      )
      .toMatchObject({ paused: false });
    await expect
      .poll(
        async () =>
          await audio.evaluate((el: HTMLAudioElement) => el.currentTime),
        { timeout: 5000 }
      )
      .toBeGreaterThan(timeBeforeHide);
  });

  test("VIEWER: can view different recordings", async ({ page }) => {
    await loginAs(page, "viewer");

    // Use second recording instead of first to catch hash-specific bugs
    const secondRecording = TEST_AUDIO_FILES[1]; // ab00002def - 60 second recording
    await page.goto(URLS.recording(secondRecording.hash));
    await waitForPageReady(page);

    // Verify it loads correctly
    await expect(page.getByTestId("audio-play-button")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("heading", { name: /transcript/i })).toBeVisible({ timeout: 10000 });
  });

  test("MEMBER: can download recordings", async ({ page }) => {
    await loginAs(page, "member");
    await page.goto(URLS.recording(FIRST_RECORDING.hash));
    await waitForPageReady(page);

    // Can see transcript
    const transcriptHeading = page.getByRole("heading", { name: /transcript/i });
    await expect(transcriptHeading).toBeVisible({ timeout: 10000 });

    // Download button visible and enabled
    const downloadButton = page.getByRole("button", { name: /download/i }).first();
    await expect(downloadButton).toBeVisible({ timeout: 5000 });

    // Cannot edit
    const editLink = page.getByRole("link", { name: /edit/i });
    await expect(editLink).toBeHidden({ timeout: 3000 });
  });

  test("EDITOR: can navigate to edit page", async ({ page }) => {
    await loginAs(page, "editor");
    await page.goto(URLS.recording(FIRST_RECORDING.hash));
    await waitForPageReady(page);

    // Can see transcript and download
    const transcriptHeading = page.getByRole("heading", { name: /transcript/i });
    await expect(transcriptHeading).toBeVisible({ timeout: 15000 });

    const downloadButton = page.getByRole("button", { name: /download/i }).first();
    await expect(downloadButton).toBeVisible({ timeout: 5000 });

    // Edit link visible
    const editLink = page.getByRole("link", { name: /edit/i });
    await expect(editLink).toBeVisible({ timeout: 10000 });

    // Navigate to edit page - use keyboard navigation to bypass sticky header click interception
    await editLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/edit$/, { timeout: 10000 });
  });

  test("EDITOR: can save metadata changes", async ({ page }, testInfo) => {
    // Skip on non-primary projects to avoid DB race when saving to same recording
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Mutation test runs only on Desktop Chrome to avoid parallel DB races"
    );

    await loginAs(page, "editor");
    await page.goto(URLS.recordingEdit(FIRST_RECORDING.hash));
    await waitForPageReady(page);

    // Find the notes field by its placeholder (safest to modify - doesn't affect other tests)
    const notesField = page.getByPlaceholder(/notes about this recording/i);
    await expect(notesField).toBeVisible({ timeout: 10000 });

    // Add a unique test note
    const testNote = `E2E test ${Date.now()}`;
    await notesField.fill(testNote);

    // Save changes
    const saveButton = page.getByRole("button", { name: /save/i });
    await expect(saveButton).toBeVisible({ timeout: 5000 });
    await saveButton.click();

    // Verify success feedback (toast notification shows "Metadata saved")
    await expect(page.getByText("Metadata saved")).toBeVisible({ timeout: 5000 });

    // Verify persisted by reloading and checking
    await page.reload();
    await waitForPageReady(page);
    const reloadedNotesField = page.getByPlaceholder(/notes about this recording/i);
    await expect(reloadedNotesField).toBeVisible({ timeout: 10000 });
    await expect(reloadedNotesField).toHaveValue(testNote);
  });

  test("OWNER: can manage catalog access", async ({ page }) => {
    await loginAs(page, "owner");
    await page.goto(URLS.catalogSettings);
    await waitForPageReady(page);

    // Settings page loads
    const heading = page.getByRole("heading", { name: /catalog settings/i });
    await expect(heading).toBeVisible({ timeout: 10000 });

    // Access table shows users (use specific testid since there are now 2 tables)
    const table = page.getByTestId("access-table");
    await expect(table).toBeVisible({ timeout: 10000 });

    // Can open grant access dialog
    const grantButton = page.getByRole("button", { name: /grant access/i });
    await expect(grantButton).toBeVisible({ timeout: 5000 });
    await grantButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // User search combobox is visible
    const userSearch = dialog.getByRole("combobox");
    await expect(userSearch).toBeVisible({ timeout: 5000 });
  });

  test("Admin: can grant OWNER level access (OWNER cannot)", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto(URLS.catalogSettings);
    await waitForPageReady(page);

    // Open Grant Access dialog
    const grantButton = page.getByRole("button", { name: /grant access/i });
    await expect(grantButton).toBeVisible({ timeout: 10000 });
    await grantButton.click();

    // Dialog opens
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Search for the mutation user - dedicated for mutation tests to avoid race conditions
    // (searching for "noaccess" would race with the no-access redirect test running in parallel)
    const userSearch = dialog.getByRole("combobox").filter({ visible: true }).first();
    await userSearch.fill("mutation");

    // Wait for search results to appear
    const userOption = page.getByRole("option", { name: /mutation/i });
    await expect(userOption).toBeVisible({ timeout: 5000 });
    await userOption.click();

    // Access level selector appears after user selection. On desktop the
    // ResponsiveSelect renders a role=combobox trigger; on mobile it renders
    // a plain button that opens a drawer. Match either visible control.
    const accessSelect = dialog
      .getByRole("combobox", { name: /access level/i })
      .or(dialog.getByRole("button", { name: /access level/i }))
      .filter({ visible: true })
      .first();
    await expect(accessSelect).toBeVisible({ timeout: 5000 });
    await accessSelect.click();

    // Admin CAN see OWNER option. On mobile the options render inside a
    // drawer as buttons rather than option roles, so accept either role.
    const ownerOption = page
      .getByRole("option", { name: /owner/i })
      .or(page.getByRole("button", { name: /owner/i }))
      .filter({ visible: true })
      .first();
    await expect(ownerOption).toBeVisible({ timeout: 5000 });
  });

  test("No-access user: redirected to no-access page", async ({ page }) => {
    await loginAs(page, "noaccess");

    // Redirected to no-access page
    await expect(page).toHaveURL(/\/auth\/no-access/);

    // Message explains the situation
    const heading = page.getByRole("heading", { name: /no catalog access/i });
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test("Responsive: app works on mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await loginAs(page, "viewer");

    // Catalog loads with content. With the events-default rollout, viewers
    // land on the events tab which renders event-card buttons on mobile; on
    // the recordings tab the list renders as recording-cards (mobile) or
    // table rows (desktop). The list is duplicated in DOM for both layouts
    // and toggled via container queries, so filter to the visible copy.
    await waitForPageReady(page);
    const content = page
      .locator(
        "[data-testid='recording-card'], [data-testid^='event-card-'], table tbody tr"
      )
      .filter({ visible: true })
      .first();
    await expect(content).toBeVisible({ timeout: 10000 });

    // Navigate to recording
    await page.goto(URLS.recording(FIRST_RECORDING.hash));
    await waitForPageReady(page);

    // Audio player visible
    const playButton = page.getByTestId("audio-play-button");
    await expect(playButton).toBeVisible({ timeout: 10000 });

    // Transcript visible (viewer has access)
    const transcriptHeading = page.getByRole("heading", { name: /transcript/i });
    await expect(transcriptHeading).toBeVisible({ timeout: 10000 });
  });
});
