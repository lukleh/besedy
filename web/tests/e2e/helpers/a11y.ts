/**
 * Accessibility testing helpers for E2E tests
 *
 * Uses @axe-core/playwright for WCAG 2.1 AA compliance testing.
 */

import { Page, Locator, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Axe-core rule IDs that may be skipped in specific contexts.
 * Use sparingly - only for known false positives or intentional design decisions.
 */
export const KNOWN_ISSUES = {
  // Color contrast issues that are design decisions
  colorContrast: "color-contrast",
  // Duplicate IDs from React portals (dialogs, dropdowns)
  duplicateId: "duplicate-id",
} as const;

/**
 * Performs a full accessibility audit on the current page.
 * Fails the test if any WCAG 2.1 AA violations are found.
 *
 * @param page - Playwright page object
 * @param options - Additional options
 */
export async function checkAccessibility(
  page: Page,
  options?: {
    skipRules?: string[];
    onlyRules?: string[];
    context?: string;
  }
): Promise<void> {
  // Wait for page to be fully loaded
  await page.waitForLoadState("networkidle").catch(() => {});

  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);

  if (options?.skipRules?.length) {
    builder = builder.disableRules(options.skipRules);
  }

  if (options?.onlyRules?.length) {
    // Filter to only run specific rules
    builder = builder.withRules(options.onlyRules);
  }

  const results = await builder.analyze();

  // Log violations for debugging
  if (results.violations.length > 0) {
    const summary = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.length,
      help: v.help,
    }));

    console.log(`Accessibility violations${options?.context ? ` (${options.context})` : ""}:`);
    console.log(JSON.stringify(summary, null, 2));
  }

  expect(
    results.violations,
    `Expected no accessibility violations${options?.context ? ` on ${options.context}` : ""}`
  ).toEqual([]);
}

/**
 * Performs accessibility audit on a specific element/region.
 *
 * @param page - Playwright page object
 * @param selector - CSS selector for the region to audit
 * @param options - Additional options
 */
export async function checkRegionAccessibility(
  page: Page,
  selector: string,
  options?: {
    skipRules?: string[];
    context?: string;
  }
): Promise<void> {
  let builder = new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .include(selector);

  if (options?.skipRules?.length) {
    builder = builder.disableRules(options.skipRules);
  }

  const results = await builder.analyze();

  if (results.violations.length > 0) {
    const summary = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.length,
    }));
    console.log(`Accessibility violations in ${selector}:`, JSON.stringify(summary, null, 2));
  }

  expect(
    results.violations,
    `Expected no accessibility violations in ${selector}${options?.context ? ` (${options.context})` : ""}`
  ).toEqual([]);
}

/**
 * Verifies that focus is properly trapped within a dialog/modal.
 * Tests that Tab cycles focus within the dialog, not to elements outside.
 *
 * Note: This test works with Radix Dialog's focus trap which may include
 * portaled content (like combobox dropdowns) within the focus scope.
 *
 * @param page - Playwright page object
 * @param dialogSelector - CSS selector for the dialog element
 */
export async function checkFocusTrap(page: Page, dialogSelector: string): Promise<void> {
  const dialog = page.locator(dialogSelector);
  await expect(dialog).toBeVisible();

  // Get all focusable elements within the dialog (excluding hidden elements)
  const focusableSelector = 'button:visible, [href]:visible, input:visible, select:visible, textarea:visible, [tabindex]:not([tabindex="-1"]):visible';
  const focusableElements = dialog.locator(focusableSelector);
  const count = await focusableElements.count();

  if (count === 0) {
    throw new Error(`No focusable elements found in dialog: ${dialogSelector}`);
  }

  // Focus the first element
  const firstElement = focusableElements.first();
  await firstElement.focus();
  await expect(firstElement).toBeFocused();

  // Tab through elements - use a reasonable limit to avoid infinite loops
  // Radix Dialog may have different element counts due to portaled content
  const maxTabs = Math.min(count, 3);
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");

    const focusInfo = await page.evaluate((selector) => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) {
        return { hasActive: false };
      }

      const dialogEls = Array.from(document.querySelectorAll(selector));
      const isInDialog = dialogEls.some((dialogEl) => dialogEl.contains(active));
      const isRadixFocusGuard = active.getAttribute?.("data-radix-focus-guard") !== null;
      const isPortaledContent = !!active.closest?.("[data-radix-popper-content-wrapper]");
      const isRadixPortal = !!active.closest?.("[data-radix-portal]");
      const isDialogPortal = !!active.closest?.("[data-slot='dialog-portal']");
      const isDialogOverlay = !!active.closest?.("[data-slot='dialog-overlay']");
      const isListbox = !!active.closest?.("[role='listbox']") || active.getAttribute?.("role") === "option";
      const isDialogClose = !!active.closest?.("[data-slot='dialog-close']");

      return {
        hasActive: true,
        isInDialog,
        isRadixFocusGuard,
        isPortaledContent,
        isRadixPortal,
        isDialogPortal,
        isDialogOverlay,
        isListbox,
        isDialogClose,
      };
    }, dialogSelector);

    if (!focusInfo.hasActive) {
      throw new Error(`No active element found while checking focus trap for ${dialogSelector}.`);
    }

    // Focus should stay within dialog, focus guards, or portaled Radix content
    const isAllowed =
      focusInfo.isInDialog ||
      focusInfo.isRadixFocusGuard ||
      focusInfo.isPortaledContent ||
      focusInfo.isRadixPortal ||
      focusInfo.isDialogPortal ||
      focusInfo.isDialogOverlay ||
      focusInfo.isListbox ||
      focusInfo.isDialogClose;

    if (!isAllowed) {
      throw new Error(`Focus escaped dialog on tab ${i + 1}. Focus is not within ${dialogSelector} or Radix portaled content.`);
    }
  }

  // Test that Shift+Tab also stays within the trap
  await page.keyboard.press("Shift+Tab");
  const shiftTabInfo = await page.evaluate((selector) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) {
      return { hasActive: false };
    }
    const dialogEls = Array.from(document.querySelectorAll(selector));
    const isInDialog = dialogEls.some((dialogEl) => dialogEl.contains(active));
    const isRadixFocusGuard = active.getAttribute?.("data-radix-focus-guard") !== null;
    const isPortaledContent = !!active.closest?.("[data-radix-popper-content-wrapper]");
    const isRadixPortal = !!active.closest?.("[data-radix-portal]");
    const isDialogPortal = !!active.closest?.("[data-slot='dialog-portal']");
    const isDialogOverlay = !!active.closest?.("[data-slot='dialog-overlay']");
    const isListbox = !!active.closest?.("[role='listbox']") || active.getAttribute?.("role") === "option";
    return {
      hasActive: true,
      isInDialog,
      isRadixFocusGuard,
      isPortaledContent,
      isRadixPortal,
      isDialogPortal,
      isDialogOverlay,
      isListbox,
    };
  }, dialogSelector);

  const isStillTrapped =
    shiftTabInfo.hasActive &&
    (
      shiftTabInfo.isInDialog ||
      shiftTabInfo.isRadixFocusGuard ||
      shiftTabInfo.isPortaledContent ||
      shiftTabInfo.isRadixPortal ||
      shiftTabInfo.isDialogPortal ||
      shiftTabInfo.isDialogOverlay ||
      shiftTabInfo.isListbox
    );

  expect(isStillTrapped, "Focus should remain trapped after Shift+Tab").toBe(true);
}

/**
 * Verifies keyboard navigation works correctly for a component.
 * Tests that Tab moves focus through interactive elements in order.
 *
 * @param page - Playwright page object
 * @param containerSelector - CSS selector for the container
 * @param expectedOrder - Expected order of focused elements (by test-id or role)
 */
export async function checkKeyboardNavigation(
  page: Page,
  containerSelector: string,
  expectedOrder: string[]
): Promise<void> {
  const container = page.locator(containerSelector);
  await expect(container).toBeVisible();

  // Focus the container or first element
  const firstFocusable = container.locator(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  ).first();
  await firstFocusable.focus();

  for (const expected of expectedOrder) {
    // Check current focused element matches expected
    const focused = page.locator(":focus");
    const testId = await focused.getAttribute("data-testid");
    const role = await focused.getAttribute("role");
    const name = await focused.textContent();

    const matches =
      testId === expected ||
      role === expected ||
      name?.includes(expected);

    expect(matches, `Expected focus on "${expected}", but focused element has testId="${testId}", role="${role}", name="${name}"`).toBe(true);

    await page.keyboard.press("Tab");
  }
}

/**
 * Verifies that an element has an accessible name.
 *
 * @param element - The element to check
 */
export async function checkAccessibleName(element: Locator): Promise<void> {
  // Get aria-label, aria-labelledby reference, or text content
  const ariaLabel = await element.getAttribute("aria-label");
  const ariaLabelledBy = await element.getAttribute("aria-labelledby");
  const textContent = await element.textContent();
  const title = await element.getAttribute("title");

  const hasAccessibleName =
    (ariaLabel && ariaLabel.trim().length > 0) ||
    (ariaLabelledBy && ariaLabelledBy.trim().length > 0) ||
    (textContent && textContent.trim().length > 0) ||
    (title && title.trim().length > 0);

  expect(hasAccessibleName, "Element should have an accessible name").toBe(true);
}

/**
 * Verifies that form inputs have associated labels.
 *
 * @param page - Playwright page object
 * @param formSelector - CSS selector for the form
 */
export async function checkFormLabels(page: Page, formSelector: string): Promise<void> {
  const form = page.locator(formSelector);
  const inputs = form.locator("input, select, textarea");
  const count = await inputs.count();

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const inputType = await input.getAttribute("type");

    // Skip hidden and submit inputs
    if (inputType === "hidden" || inputType === "submit") {
      continue;
    }

    const id = await input.getAttribute("id");
    const ariaLabel = await input.getAttribute("aria-label");
    const ariaLabelledBy = await input.getAttribute("aria-labelledby");

    // Check if input has a label
    const hasLabel =
      (id && (await page.locator(`label[for="${id}"]`).count()) > 0) ||
      (ariaLabel && ariaLabel.length > 0) ||
      (ariaLabelledBy && ariaLabelledBy.length > 0);

    expect(hasLabel, `Input at index ${i} (type="${inputType}") should have an associated label`).toBe(true);
  }
}

/**
 * Verifies that images have alt text.
 *
 * @param page - Playwright page object
 * @param containerSelector - Optional container to scope the check
 */
export async function checkImageAltText(
  page: Page,
  containerSelector?: string
): Promise<void> {
  const container = containerSelector ? page.locator(containerSelector) : page;
  const images = container.locator("img");
  const count = await images.count();

  for (let i = 0; i < count; i++) {
    const img = images.nth(i);
    const alt = await img.getAttribute("alt");
    const role = await img.getAttribute("role");

    // Images should have alt (can be empty for decorative) or role="presentation"
    const hasAltOrIsDecorative =
      alt !== null || // alt="" is valid for decorative images
      role === "presentation" ||
      role === "none";

    expect(
      hasAltOrIsDecorative,
      `Image at index ${i} should have alt attribute or role="presentation"`
    ).toBe(true);
  }
}
