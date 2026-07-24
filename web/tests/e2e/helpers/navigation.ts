/**
 * Navigation helpers for E2E tests
 *
 * Handles responsive navigation patterns (hamburger menus, sidebars, etc.)
 */

import { Page, Locator, expect } from "@playwright/test";

/**
 * Opens the mobile hamburger menu if on a mobile viewport.
 * The header uses `hidden md:flex` for navigation links,
 * meaning they're only visible on screens >= 768px.
 *
 * @param page - Playwright page object
 * @param breakpoint - Viewport width breakpoint (default: 768 for md:)
 */
export async function openMobileMenuIfNeeded(page: Page, breakpoint = 768): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < breakpoint) {
    // Look for hamburger/menu button
    const menuButton = page.getByTestId("mobile-menu-button").or(
      page.getByRole("button", { name: /toggle menu/i })
    ).or(page.getByRole("button", { name: /menu/i })).first();
    if (await menuButton.isVisible().catch(() => false)) {
      await menuButton.click();
      // Wait for Sheet dialog to be visible (more reliable than fixed timeout)
      const dialog = page.getByTestId("mobile-menu").or(page.locator("[role='dialog']")).first();
      await dialog.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
      // Additional small wait for animation to settle
      await page.waitForTimeout(100);
    }
  }
}

/**
 * Opens the admin sidebar on smaller viewports.
 * The admin layout uses similar responsive patterns as metadata layout.
 *
 * @param page - Playwright page object
 * @param breakpoint - Viewport width breakpoint (default: 1024 for lg:)
 */
export async function openAdminSidebarIfNeeded(page: Page, breakpoint = 1024): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < breakpoint) {
    const sidebarButton = page.getByRole("button", { name: /menu|sidebar/i }).first();
    if (await sidebarButton.isVisible().catch(() => false)) {
      await sidebarButton.click();
      await page.locator("[role='dialog'], aside, nav").first()
        .waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    }
  }
}

/**
 * Opens the metadata sidebar on smaller viewports.
 * The metadata layout uses `lg:static` / `lg:hidden` patterns,
 * meaning the sidebar is hidden on screens < 1024px.
 *
 * @param page - Playwright page object
 * @param breakpoint - Viewport width breakpoint (default: 1024 for lg:)
 */
export async function openMetadataSidebarIfNeeded(page: Page, breakpoint = 1024): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < breakpoint) {
    // Look for sidebar toggle button
    const sidebarButton = page.getByRole("button", { name: /menu|sidebar/i }).first();
    if (await sidebarButton.isVisible().catch(() => false)) {
      await sidebarButton.click();
      // Wait for sidebar to appear (Sheet dialog pattern)
      const sidebar = page.locator("[role='dialog'], aside").first();
      await sidebar.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    }
  }
}

/**
 * Kept for backward compatibility with older tests.
 * Mobile filters are now always visible as chips, so there is no panel to open.
 */
export async function openCatalogFiltersIfNeeded(page: Page, breakpoint = 768): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < breakpoint) {
    await page.locator("[data-testid='mobile-filter-chips']").first().waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
  }
}

/**
 * Finds the first visible catalog search input across responsive layouts.
 */
export async function findVisibleCatalogSearchInput(page: Page): Promise<Locator | null> {
  const candidates = page
    .getByTestId("catalog-rag-search-input")
    .or(page.getByPlaceholder(/search transcript content/i))
    .or(page.getByPlaceholder(/search/i))
    .or(page.getByRole("searchbox"));

  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const candidate = candidates.nth(i);
    const isVisible = await candidate.isVisible().catch(() => false);
    if (isVisible) {
      return candidate;
    }
  }

  return null;
}

/**
 * Waits until the catalog search input is focused.
 */
export async function waitForCatalogSearchFocus(page: Page, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForFunction(() => {
      const selectors = [
        "input[data-testid='catalog-rag-search-input']",
        "input[placeholder*='transcript']",
        "input[placeholder*='Search']",
        "input[placeholder*='search']",
        "input[role='searchbox']",
      ];
      const candidates = selectors.flatMap((selector) =>
        Array.from(document.querySelectorAll<HTMLInputElement>(selector))
      );
      const visible = candidates.find((el) => !!el.offsetParent);
      if (!visible) return false;
      return document.activeElement === visible;
    }, { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until the catalog search input has the expected value.
 */
export async function waitForCatalogSearchValue(
  page: Page,
  expected: RegExp | string,
  timeout = 5000
): Promise<boolean> {
  const matcher = expected instanceof RegExp
    ? { source: expected.source, flags: expected.flags }
    : { source: expected, flags: "" };

  try {
    await page.waitForFunction((value) => {
      const { source, flags } = value as { source: string; flags: string };
      const matcher = new RegExp(source, flags);
      const selectors = [
        "input[data-testid='catalog-rag-search-input']",
        "input[placeholder*='transcript']",
        "input[placeholder*='Search']",
        "input[placeholder*='search']",
        "input[role='searchbox']",
      ];
      const candidates = selectors.flatMap((selector) =>
        Array.from(document.querySelectorAll<HTMLInputElement>(selector))
      );
      const visible = candidates.find((el) => !!el.offsetParent);
      if (!visible) return false;
      return matcher.test(visible.value ?? "");
    }, matcher, { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits for the page to be fully loaded including React Query data.
 * This is more reliable than just waitForLoadState("networkidle").
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait in ms (default: 30000)
 */
export async function waitForPageReady(page: Page, timeout = 30000): Promise<void> {
  // Wait for DOM content to load
  await page.waitForLoadState("domcontentloaded");

  // Wait for network to settle first - this catches most data loading
  await page.waitForLoadState("networkidle").catch(() => {});

  // Wait for main content area to be visible
  const main = page.locator("main").first();
  await main.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

  // Wait for "Loading..." text to disappear (React Query loading states)
  const loadingText = page.getByText(/^Loading/i).first();
  if (await loadingText.isVisible().catch(() => false)) {
    await expect(loadingText).not.toBeVisible({ timeout });
  }

  // Wait for skeleton loaders to disappear
  const skeleton = page.locator("[class*='skeleton'], [class*='Skeleton']").first();
  if (await skeleton.isVisible().catch(() => false)) {
    await expect(skeleton).not.toBeVisible({ timeout: 15000 });
  }

  // Final network idle wait after content settles
  await page.waitForLoadState("networkidle").catch(() => {});
}

/**
 * Waits for a table to have actual data rows (not just loading/empty states).
 * Useful for admin pages and catalog lists that fetch data via React Query.
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait in ms (default: 15000)
 * @returns true if data rows found, false if empty state
 */
export async function waitForTableData(page: Page, timeout = 15000): Promise<boolean> {
  const card = page.locator("[data-testid='recording-card']").first();
  if (await card.isVisible().catch(() => false)) {
    return true;
  }

  // First wait for the table to exist
  const table = page.locator("table").first();
  await table.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

  if (!(await table.isVisible().catch(() => false))) {
    const cardVisible = await card.waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
    return cardVisible;
  }

  // Wait for loading states inside table to clear
  const loadingCell = table.getByText(/loading/i).first();
  if (await loadingCell.isVisible().catch(() => false)) {
    await expect(loadingCell).not.toBeVisible({ timeout });
  }

  // Check if we have actual data rows (not empty/filter header rows)
  // Data rows have multiple cells with content, or are clickable
  const tbody = table.locator("tbody");
  const dataRows = tbody.locator("tr");

  // Wait for at least one row to appear
  await dataRows.first().waitFor({ state: "visible", timeout }).catch(() => {});

  // Count rows - if we have data, there should be at least one row
  const rowCount = await dataRows.count();

  return rowCount > 0;
}

/**
 * Waits for data content to load, adapting to viewport.
 *
 * On mobile (<768px), the catalog uses a card layout instead of tables.
 * This function detects the viewport and waits for the appropriate content.
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait in ms (default: 15000)
 * @param breakpoint - Viewport width breakpoint for mobile (default: 768)
 * @returns true if data content found, false if empty state
 */
export async function waitForDataContent(
  page: Page,
  timeout = 15000,
  breakpoint = 768
): Promise<boolean> {
  const viewport = page.viewportSize();
  const isMobile = viewport && viewport.width < breakpoint;

  if (isMobile) {
    // Mobile: wait for card view (recordings are shown as cards with h3 titles)
    // Look for recording cards or any content cards
    const cardContent = page.locator(
      "[data-testid='recording-card'], main article, main .space-y-3 > div"
    ).first();

    try {
      await cardContent.waitFor({ state: "visible", timeout });
      return true;
    } catch {
      // Check for empty state
      const emptyState = page.getByText(/no recordings|no results|empty/i);
      if (await emptyState.isVisible().catch(() => false)) {
        return false;
      }
      // If neither cards nor empty state, try table as fallback
      // (some pages like admin users still use tables on mobile)
      return waitForTableData(page, timeout);
    }
  } else {
    // Desktop: use standard table data wait
    return waitForTableData(page, timeout);
  }
}

/**
 * Waits for a mutation/action to complete by watching for element changes.
 * Useful after CRUD operations.
 *
 * @param page - Playwright page object
 * @param selector - Element to wait for
 * @param timeout - Maximum time to wait in ms (default: 5000)
 */
export async function waitForMutation(page: Page, selector: string, timeout = 5000): Promise<void> {
  const element = page.locator(selector).first();
  await expect(element).toBeVisible({ timeout });
}

/**
 * Opens a dropdown/combobox and selects an option by name.
 * More reliable than sequential click + wait + click patterns.
 *
 * @param page - Playwright page object
 * @param trigger - The dropdown trigger element (combobox, button, etc.)
 * @param optionName - Text pattern to match the option
 * @param timeout - Maximum time to wait for option visibility (default: 3000)
 */
export async function selectDropdownOption(
  page: Page,
  trigger: Locator,
  optionName: RegExp | string,
  timeout = 3000
): Promise<void> {
  await trigger.click();
  const option = page.getByRole("option", { name: optionName });
  await option.waitFor({ state: "visible", timeout });
  await option.click();
}

/**
 * Waits for a dialog/modal to close.
 * Useful after pressing Escape or clicking close button.
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait (default: 5000)
 */
export async function waitForDialogClose(page: Page, timeout = 5000): Promise<void> {
  const dialog = page.locator("[role='dialog']").first();
  if (await dialog.isVisible().catch(() => false)) {
    await expect(dialog).not.toBeVisible({ timeout });
  }
}

/**
 * Waits for the filter-options API response to complete.
 * Useful after changing column configuration which triggers a refetch.
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait (default: 10000)
 */
export async function waitForFilterOptions(page: Page, timeout = 10000): Promise<void> {
  await page.waitForResponse(
    response => response.url().includes('/api/catalog/filter-options'),
    { timeout }
  ).catch(() => {});
}

/**
 * Waits for audio player state change (play/pause).
 * More reliable than fixed timeouts for audio interactions.
 *
 * @param page - Playwright page object
 * @param expectedState - "playing" or "paused"
 * @param timeout - Maximum time to wait (default: 3000)
 */
export async function waitForAudioState(
  page: Page,
  expectedState: "playing" | "paused",
  timeout = 3000
): Promise<boolean> {
  const playButton = page.getByTestId("audio-play-button").first();
  const audioElement = page.locator("audio").first();
  const deadline = Date.now() + timeout;
  const target = expectedState === "playing" ? /pause|reconnecting/i : /play/i;

  while (Date.now() < deadline) {
    const audioState = await audioElement.evaluate((audio: HTMLAudioElement) => ({
      currentSrc: audio.currentSrc,
      currentTime: audio.currentTime,
      paused: audio.paused,
      readyState: audio.readyState,
    })).catch(() => null);

    if (audioState) {
      const hasPlaybackSource = audioState.currentSrc.includes("/audio");
      const canPlay = audioState.readyState >= 2;
      const hasProgress = audioState.currentTime > 0;

      if (expectedState === "playing" && hasPlaybackSource && !audioState.paused && (canPlay || hasProgress)) {
        return true;
      }

      if (expectedState === "paused" && audioState.paused) {
        return true;
      }
    }

    const label = await playButton.getAttribute("aria-label").catch(() => null);
    if (label && target.test(label)) {
      return true;
    }
    await page.waitForTimeout(100);
  }

  return false;
}

/**
 * Open the first playable item from the current catalog landing view.
 *
 * The catalog can render either recordings or events depending on rollout and
 * user capabilities. Desktop uses table rows; narrow viewports use cards.
 *
 * @returns Which route was opened
 */
export async function openFirstPlayableCatalogItem(
  page: Page,
  timeout = 10000
): Promise<"recording" | "event"> {
  const deadline = Date.now() + timeout;

  const mobileRecordingCard = page
    .getByTestId("recording-card")
    .filter({ visible: true })
    .first();
  const mobileEventCard = page
    .locator("[data-testid^='event-card-']")
    .filter({ visible: true })
    .first();
  const tableRow = page
    .locator("table tbody tr")
    .filter({ visible: true })
    .first();

  while (Date.now() < deadline) {
    const candidates: Array<{
      expectedRoute: "recording" | "event" | null;
      locator: Locator;
    }> = [
      { expectedRoute: "recording", locator: mobileRecordingCard },
      { expectedRoute: "event", locator: mobileEventCard },
      { expectedRoute: null, locator: tableRow },
    ];

    for (const candidate of candidates) {
      const isVisible = await candidate.locator.isVisible().catch(() => false);
      if (!isVisible) {
        continue;
      }

      await candidate.locator.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.locator.click();

      if (candidate.expectedRoute) {
        await page.waitForURL(
          new RegExp(`/catalog/[^/]+/${candidate.expectedRoute}/`),
          { timeout: 5000 }
        );
        return candidate.expectedRoute;
      }

      await page.waitForURL(/\/catalog\/[^/]+\/(recording|event)\//, {
        timeout: 5000,
      });
      return page.url().includes("/recording/") ? "recording" : "event";
    }

    await page.waitForTimeout(200);
  }

  throw new Error("No playable catalog item became visible");
}

/**
 * Console error collector for detecting JavaScript errors during tests.
 * Use this to catch runtime errors that would otherwise go unnoticed.
 *
 * @example
 * ```typescript
 * test("page loads without errors", async ({ page }) => {
 *   const collector = createConsoleErrorCollector(page);
 *   collector.start();
 *
 *   await page.goto("/some-page");
 *   await doSomeInteractions(page);
 *
 *   collector.stop();
 *   collector.assertNoErrors();
 * });
 * ```
 *
 * @example With ignored patterns (e.g., expected 403 errors):
 * ```typescript
 * collector.assertNoErrors([/Admin access required/i, /403/]);
 * ```
 */
export interface ConsoleErrorCollector {
  /** Array of collected error messages */
  errors: string[];
  /** Start collecting console errors */
  start: () => void;
  /** Stop collecting console errors */
  stop: () => void;
  /** Assert no unexpected errors occurred. Pass patterns to ignore expected errors. */
  assertNoErrors: (ignorePatterns?: RegExp[]) => void;
  /** Check if there are errors (without asserting) */
  hasErrors: (ignorePatterns?: RegExp[]) => boolean;
}

export function createConsoleErrorCollector(page: Page): ConsoleErrorCollector {
  const errors: string[] = [];
  let handler: ((msg: { type: () => string; text: () => string }) => void) | null = null;

  return {
    errors,

    start() {
      handler = (msg) => {
        if (msg.type() === "error") {
          errors.push(msg.text());
        }
      };
      page.on("console", handler);
    },

    stop() {
      if (handler) {
        page.off("console", handler);
        handler = null;
      }
    },

    hasErrors(ignorePatterns: RegExp[] = []) {
      const relevantErrors = errors.filter(
        (error) => !ignorePatterns.some((pattern) => pattern.test(error))
      );
      return relevantErrors.length > 0;
    },

    assertNoErrors(ignorePatterns: RegExp[] = []) {
      const relevantErrors = errors.filter(
        (error) => !ignorePatterns.some((pattern) => pattern.test(error))
      );
      if (relevantErrors.length > 0) {
        throw new Error(
          `Unexpected console errors detected:\n${relevantErrors.map((e) => `  - ${e}`).join("\n")}`
        );
      }
    },
  };
}
