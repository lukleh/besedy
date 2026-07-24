/**
 * Visual testing helpers for E2E tests
 *
 * Provides screenshot comparison utilities using Playwright's built-in
 * toHaveScreenshot() for visual regression testing.
 *
 * Includes mobile viewport presets for responsive testing.
 */

import { Page, Locator, expect } from "@playwright/test";

/**
 * Standard mobile device viewport presets
 *
 * These match common device screen sizes for mobile testing.
 */
export const MOBILE_VIEWPORTS = {
  // Small phones
  iPhoneSE: { width: 375, height: 667, name: "iPhoneSE" },
  // Standard phones
  iPhone14: { width: 390, height: 844, name: "iPhone14" },
  iPhone14ProMax: { width: 430, height: 932, name: "iPhone14ProMax" },
  Pixel7: { width: 412, height: 915, name: "Pixel7" },
  GalaxyS21: { width: 360, height: 800, name: "GalaxyS21" },
  // Tablets (portrait)
  iPadMini: { width: 768, height: 1024, name: "iPadMini" },
  iPadPro: { width: 1024, height: 1366, name: "iPadPro" },
  GalaxyTabS4: { width: 712, height: 1138, name: "GalaxyTabS4" },
} as const;

export type MobileViewport = keyof typeof MOBILE_VIEWPORTS;

/**
 * Critical viewports for testing breakpoint transitions
 */
export const CRITICAL_VIEWPORTS = {
  // Just below md breakpoint
  belowMd: { width: 767, height: 800, name: "below-md" },
  // At md breakpoint
  atMd: { width: 768, height: 800, name: "at-md" },
  // Just below lg breakpoint
  belowLg: { width: 1023, height: 800, name: "below-lg" },
  // At lg breakpoint
  atLg: { width: 1024, height: 800, name: "at-lg" },
} as const;

/**
 * Elements that should be masked in screenshots to avoid false positives.
 * These contain dynamic content like timestamps, avatars, or randomly generated IDs.
 */
const DYNAMIC_ELEMENT_SELECTORS = [
  "[data-testid='timestamp']",
  "[data-testid='avatar']",
  "[data-testid='user-avatar']",
  "time",
  "[datetime]",
];

/**
 * Captures a full-page screenshot for visual regression testing.
 * Automatically masks dynamic content to reduce false positives.
 *
 * @param page - Playwright page object
 * @param name - Screenshot name (without extension)
 * @param options - Additional options
 */
export async function capturePageScreenshot(
  page: Page,
  name: string,
  options?: {
    fullPage?: boolean;
    mask?: Locator[];
    threshold?: number;
  }
): Promise<void> {
  // Wait for animations to settle
  await page.waitForTimeout(300);

  // Collect dynamic elements to mask
  const dynamicMasks: Locator[] = [];
  for (const selector of DYNAMIC_ELEMENT_SELECTORS) {
    const elements = page.locator(selector);
    const count = await elements.count();
    if (count > 0) {
      dynamicMasks.push(elements);
    }
  }

  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: options?.fullPage ?? false,
    mask: [...dynamicMasks, ...(options?.mask ?? [])],
    threshold: options?.threshold ?? 0.2,
    maxDiffPixels: 100,
  });
}

/**
 * Captures a screenshot of a specific element for component-level visual testing.
 *
 * @param element - The element to screenshot
 * @param name - Screenshot name (without extension)
 * @param options - Additional options
 */
export async function captureElementScreenshot(
  element: Locator,
  name: string,
  options?: {
    mask?: Locator[];
    threshold?: number;
  }
): Promise<void> {
  // Wait for animations to settle
  await element.page().waitForTimeout(300);

  await expect(element).toHaveScreenshot(`${name}.png`, {
    mask: options?.mask ?? [],
    threshold: options?.threshold ?? 0.2,
    maxDiffPixels: 50,
  });
}

/**
 * Prepares a page for visual testing by:
 * - Waiting for network idle
 * - Waiting for loading states to clear
 * - Disabling animations
 *
 * @param page - Playwright page object
 */
export async function prepareForVisualTest(page: Page): Promise<void> {
  // Wait for network to settle
  await page.waitForLoadState("networkidle").catch(() => {});

  // Wait for loading states to clear
  const loading = page.getByText(/^Loading/i).first();
  if (await loading.isVisible().catch(() => false)) {
    await expect(loading).not.toBeVisible({ timeout: 10000 });
  }

  // Wait for skeleton loaders to disappear
  const skeleton = page.locator("[class*='skeleton']").first();
  if (await skeleton.isVisible().catch(() => false)) {
    await expect(skeleton).not.toBeVisible({ timeout: 10000 });
  }

  // Disable CSS animations/transitions for consistent screenshots
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `,
  });
}

/**
 * Enables dark mode on the page for dark mode visual testing.
 *
 * @param page - Playwright page object
 */
export async function enableDarkMode(page: Page): Promise<void> {
  // Click theme toggle if available
  const themeToggle = page.getByRole("button", { name: /theme|dark|light/i });
  if (await themeToggle.isVisible().catch(() => false)) {
    // Check if already in dark mode
    const html = page.locator("html");
    const className = await html.getAttribute("class") ?? "";
    if (!className.includes("dark")) {
      await themeToggle.click();
      // Wait for theme transition
      await page.waitForTimeout(300);
    }
  } else {
    // Fallback: set dark class directly
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
    });
    await page.waitForTimeout(100);
  }
}

/**
 * Ensures light mode is active on the page.
 *
 * @param page - Playwright page object
 */
export async function ensureLightMode(page: Page): Promise<void> {
  const html = page.locator("html");
  const className = await html.getAttribute("class") ?? "";
  if (className.includes("dark")) {
    const themeToggle = page.getByRole("button", { name: /theme|dark|light/i });
    if (await themeToggle.isVisible().catch(() => false)) {
      await themeToggle.click();
      await page.waitForTimeout(300);
    } else {
      await page.evaluate(() => {
        document.documentElement.classList.remove("dark");
      });
      await page.waitForTimeout(100);
    }
  }
}

/**
 * Captures a mobile-optimized screenshot with device-specific naming.
 *
 * Sets the viewport to the specified device size before capturing.
 *
 * @param page - Playwright page object
 * @param name - Base screenshot name
 * @param deviceName - Device preset to use
 * @param options - Additional options
 */
export async function captureMobileScreenshot(
  page: Page,
  name: string,
  deviceName: MobileViewport,
  options?: {
    fullPage?: boolean;
    mask?: Locator[];
    threshold?: number;
  }
): Promise<void> {
  const viewport = MOBILE_VIEWPORTS[deviceName];

  // Set viewport to device size
  await page.setViewportSize({ width: viewport.width, height: viewport.height });

  // Wait for layout to stabilize
  await page.waitForTimeout(300);

  // Prepare for visual test
  await prepareForVisualTest(page);

  // Collect dynamic elements to mask
  const dynamicMasks: Locator[] = [];
  for (const selector of DYNAMIC_ELEMENT_SELECTORS) {
    const elements = page.locator(selector);
    const count = await elements.count();
    if (count > 0) {
      dynamicMasks.push(elements);
    }
  }

  await expect(page).toHaveScreenshot(`${name}-${deviceName}.png`, {
    fullPage: options?.fullPage ?? false,
    mask: [...dynamicMasks, ...(options?.mask ?? [])],
    threshold: options?.threshold ?? 0.15, // Tighter threshold for mobile
    maxDiffPixels: 75,
  });
}

/**
 * Captures screenshots at multiple mobile viewports.
 *
 * Useful for comprehensive responsive testing.
 *
 * @param page - Playwright page object
 * @param name - Base screenshot name
 * @param viewports - Device presets to capture (default: iPhoneSE, iPhone14ProMax, iPadMini)
 * @param options - Additional options
 */
export async function captureResponsiveScreenshots(
  page: Page,
  name: string,
  viewports: MobileViewport[] = ["iPhoneSE", "iPhone14ProMax", "iPadMini"],
  options?: {
    fullPage?: boolean;
    mask?: Locator[];
  }
): Promise<void> {
  for (const viewport of viewports) {
    await captureMobileScreenshot(page, name, viewport, options);
  }
}

/**
 * Captures screenshots at critical breakpoint boundaries.
 *
 * Tests layout transitions at Tailwind breakpoints (md: 768px, lg: 1024px).
 *
 * @param page - Playwright page object
 * @param name - Base screenshot name
 * @param options - Additional options
 */
export async function captureBreakpointScreenshots(
  page: Page,
  name: string,
  options?: {
    fullPage?: boolean;
    mask?: Locator[];
  }
): Promise<void> {
  for (const [key, viewport] of Object.entries(CRITICAL_VIEWPORTS)) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(300);
    await prepareForVisualTest(page);

    // Collect dynamic elements to mask
    const dynamicMasks: Locator[] = [];
    for (const selector of DYNAMIC_ELEMENT_SELECTORS) {
      const elements = page.locator(selector);
      const count = await elements.count();
      if (count > 0) {
        dynamicMasks.push(elements);
      }
    }

    await expect(page).toHaveScreenshot(`${name}-${viewport.name}.png`, {
      fullPage: options?.fullPage ?? false,
      mask: [...dynamicMasks, ...(options?.mask ?? [])],
      threshold: 0.15,
      maxDiffPixels: 75,
    });
  }
}
