/**
 * Touch gesture helpers for mobile E2E testing
 *
 * These helpers simulate touch interactions that are common on mobile devices,
 * including swipe gestures, long press, tap, and double tap.
 *
 * Note: For touch events to work properly, the Playwright project should
 * have `hasTouch: true` and `isMobile: true` in its configuration.
 */

import { Page, Locator } from "@playwright/test";

/**
 * Swipe direction
 */
export type SwipeDirection = "left" | "right" | "up" | "down";

/**
 * Options for swipe gesture
 */
export interface SwipeOptions {
  /** Element to swipe on (defaults to viewport center) */
  element?: Locator;
  /** Distance to swipe in pixels (default: 200) */
  distance?: number;
  /** Duration of swipe in milliseconds (default: 300) */
  duration?: number;
  /** Number of intermediate steps (default: 10) */
  steps?: number;
}

/**
 * Simulates a swipe gesture on a page or element
 *
 * @param page - Playwright page object
 * @param direction - Direction to swipe
 * @param options - Swipe options
 */
export async function swipe(
  page: Page,
  direction: SwipeDirection,
  options: SwipeOptions = {}
): Promise<void> {
  const { element, distance = 200, steps = 10 } = options;

  let startX: number;
  let startY: number;

  if (element) {
    const box = await element.boundingBox();
    if (!box) {
      throw new Error("Element not visible for swipe gesture");
    }
    startX = box.x + box.width / 2;
    startY = box.y + box.height / 2;
  } else {
    const viewport = page.viewportSize();
    startX = (viewport?.width ?? 375) / 2;
    startY = (viewport?.height ?? 667) / 2;
  }

  const vectors: Record<SwipeDirection, { dx: number; dy: number }> = {
    left: { dx: -distance, dy: 0 },
    right: { dx: distance, dy: 0 },
    up: { dx: 0, dy: -distance },
    down: { dx: 0, dy: distance },
  };

  const { dx, dy } = vectors[direction];
  const endX = startX + dx;
  const endY = startY + dy;

  // Perform the swipe gesture
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps });
  await page.mouse.up();
}

/**
 * Simulates a horizontal swipe (left or right)
 */
export async function swipeHorizontal(
  page: Page,
  direction: "left" | "right",
  options?: Omit<SwipeOptions, "direction">
): Promise<void> {
  await swipe(page, direction, options);
}

/**
 * Simulates a vertical swipe (up or down)
 */
export async function swipeVertical(
  page: Page,
  direction: "up" | "down",
  options?: Omit<SwipeOptions, "direction">
): Promise<void> {
  await swipe(page, direction, options);
}

/**
 * Options for long press gesture
 */
export interface LongPressOptions {
  /** Duration to hold in milliseconds (default: 500) */
  duration?: number;
}

/**
 * Simulates a long press gesture on an element
 *
 * @param element - Element to long press on
 * @param options - Long press options
 */
export async function longPress(
  element: Locator,
  options: LongPressOptions = {}
): Promise<void> {
  const { duration = 500 } = options;

  const box = await element.boundingBox();
  if (!box) {
    throw new Error("Element not visible for long press gesture");
  }

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  const page = element.page();

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.waitForTimeout(duration);
  await page.mouse.up();
}

/**
 * Simulates a tap gesture on an element
 *
 * This is equivalent to a click but semantically represents a touch tap.
 * Use this in mobile-specific tests for clarity.
 *
 * @param element - Element to tap on
 */
export async function tap(element: Locator): Promise<void> {
  await element.tap();
}

/**
 * Simulates a double tap gesture on an element
 *
 * @param element - Element to double tap on
 */
export async function doubleTap(element: Locator): Promise<void> {
  // Playwright tap() doesn't support tapCount, so we tap twice quickly
  await element.tap();
  await element.tap();
}

/**
 * Simulates a tap at specific coordinates
 *
 * @param page - Playwright page object
 * @param x - X coordinate
 * @param y - Y coordinate
 */
export async function tapAt(page: Page, x: number, y: number): Promise<void> {
  await page.touchscreen.tap(x, y);
}

/**
 * Scroll by swiping on mobile
 *
 * This is different from page.scroll() as it simulates actual touch scrolling.
 *
 * @param page - Playwright page object
 * @param direction - Direction to scroll content (up = scroll down to see more)
 * @param distance - Distance to scroll in pixels
 */
export async function scrollBySwipe(
  page: Page,
  direction: "up" | "down",
  distance: number = 300
): Promise<void> {
  // To scroll content up (see more below), swipe up
  // To scroll content down (see more above), swipe down
  await swipe(page, direction, { distance });
}

/**
 * Pull to refresh gesture
 *
 * Simulates the common pull-to-refresh pattern on mobile.
 *
 * @param page - Playwright page object
 * @param distance - Distance to pull down (default: 150)
 */
export async function pullToRefresh(
  page: Page,
  distance: number = 150
): Promise<void> {
  const viewport = page.viewportSize();
  const startX = (viewport?.width ?? 375) / 2;
  const startY = 100; // Start near top of screen

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + distance, { steps: 20 });
  await page.waitForTimeout(100); // Hold briefly
  await page.mouse.up();
}

/**
 * Check if the current test is running on a mobile device configuration
 *
 * @param page - Playwright page object
 * @returns True if viewport is mobile-sized (<768px)
 */
export function isMobileViewport(page: Page): boolean {
  const viewport = page.viewportSize();
  return (viewport?.width ?? 0) < 768;
}

/**
 * Check if the current test is running on a tablet device configuration
 *
 * @param page - Playwright page object
 * @returns True if viewport is tablet-sized (768px - 1023px)
 */
export function isTabletViewport(page: Page): boolean {
  const viewport = page.viewportSize();
  const width = viewport?.width ?? 0;
  return width >= 768 && width < 1024;
}

/**
 * Wait for touch scrolling to settle
 *
 * After a swipe gesture, the page may continue scrolling due to momentum.
 * This helper waits for the scroll to settle.
 *
 * @param page - Playwright page object
 * @param timeout - Maximum time to wait in ms (default: 1000)
 */
export async function waitForScrollSettle(
  page: Page,
  timeout: number = 1000
): Promise<void> {
  const startTime = Date.now();
  let lastScrollY = await page.evaluate(() => window.scrollY);

  while (Date.now() - startTime < timeout) {
    await page.waitForTimeout(100);
    const currentScrollY = await page.evaluate(() => window.scrollY);
    if (currentScrollY === lastScrollY) {
      return; // Scroll has settled
    }
    lastScrollY = currentScrollY;
  }
}
