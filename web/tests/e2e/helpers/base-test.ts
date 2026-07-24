/**
 * Base test fixture with automatic page error detection.
 *
 * This extends Playwright's default test to automatically catch uncaught
 * JavaScript exceptions (like SecurityError from replaceState loops).
 *
 * Usage:
 * ```typescript
 * import { test, expect } from "./helpers/base-test";
 * ```
 *
 * Tests using this fixture will automatically fail if:
 * - An uncaught JavaScript exception occurs (pageerror event)
 * - The page crashes completely (crash event)
 *
 * This catches issues like:
 * - SecurityError: Attempt to use history.replaceState() more than 100 times per 10 seconds
 * - Uncaught TypeErrors, ReferenceErrors, etc.
 * - React rendering errors that crash the page
 */

import { test as baseTest, expect } from "@playwright/test";

/**
 * Patterns to ignore in page errors.
 * Some errors are expected and don't indicate real bugs.
 */
const IGNORED_ERROR_PATTERNS: RegExp[] = [
  // React hydration mismatches are common in Next.js apps with dynamic content
  // Error #418: "Hydration failed because the initial UI does not match"
  // Error #423: "There was an error while hydrating"
  // Error #425: "Text content does not match server-rendered HTML"
  /Minified React error #41[8-9]|#42[0-5]/,
  /Hydration failed/i,
  /Text content does not match/i,
  /did not match/i,

  // ResizeObserver errors are benign and happen during layout shifts
  /ResizeObserver loop/i,

  // CORS/Fetch API access control checks can occur during navigation transitions
  /Fetch API cannot load.*access control checks/i,
];

/**
 * Extended test fixture with automatic page error detection.
 *
 * The fixture attaches error listeners before the test runs and
 * validates no errors occurred after the test completes.
 */
export const test = baseTest.extend<{
  /**
   * Collected page errors (available in test for custom assertions).
   * This fixture auto-uses and will fail the test if unexpected errors are detected.
   */
  pageErrors: string[];

  /**
   * Set to true to suppress automatic failure when page errors occur.
   * Use this for tests that intentionally trigger errors.
   *
   * @example
   * ```typescript
   * test("handles error gracefully", async ({ page, pageErrors }) => {
   *   test.info().annotations.push({ type: "expectPageErrors", description: "true" });
   *   await page.goto("/page-that-throws");
   *   expect(pageErrors).toContainEqual(expect.stringContaining("Expected error"));
   * });
   * ```
   *
   * Or use the helper:
   * ```typescript
   * import { test, expectingPageErrors } from "./helpers/base-test";
   * test("handles error", async ({ page, pageErrors }) => {
   *   expectingPageErrors(test);
   *   // ... test code ...
   * });
   * ```
   */
  _expectPageErrors: boolean;
}>({
  _expectPageErrors: [false, { option: true }],

  pageErrors: [
    async ({ page, _expectPageErrors }, use, testInfo) => {
      const errors: string[] = [];

      // Check if test expects errors via annotation
      const expectsErrors = _expectPageErrors ||
        testInfo.annotations.some(a => a.type === "expectPageErrors" && a.description === "true");

      // Catch uncaught JavaScript exceptions
      const pageErrorHandler = (error: Error) => {
        const message = `${error.name}: ${error.message}`;
        // Check if this error should be ignored
        const shouldIgnore = IGNORED_ERROR_PATTERNS.some((pattern) =>
          pattern.test(message)
        );
        if (!shouldIgnore) {
          errors.push(message);
        }
      };

      // Catch page crashes
      const crashHandler = () => {
        errors.push("PAGE_CRASH: The page crashed unexpectedly");
      };

      page.on("pageerror", pageErrorHandler);
      page.on("crash", crashHandler);

      // Run the test
      await use(errors);

      // Cleanup
      page.off("pageerror", pageErrorHandler);
      page.off("crash", crashHandler);

      // After test: fail if there were unexpected errors (unless test expects them)
      if (errors.length > 0 && !expectsErrors) {
        throw new Error(
          `Uncaught JavaScript errors detected during test:\n${errors
            .map((e) => `  - ${e}`)
            .join("\n")}\n\nThis often indicates a bug like an infinite loop, ` +
            `missing error handling, or a React rendering issue.\n\n` +
            `If this test intentionally triggers errors, use expectingPageErrors(test) to suppress this.`
        );
      }
    },
    { auto: true }, // Automatically use this fixture for all tests
  ],
});

// Re-export expect for convenience
export { expect };

/**
 * Mark a test as expecting page errors, suppressing automatic failure.
 * Call this at the start of tests that intentionally trigger JavaScript errors.
 *
 * @example
 * ```typescript
 * import { test, expect, expectingPageErrors } from "./helpers/base-test";
 *
 * test("handles error gracefully", async ({ page, pageErrors }) => {
 *   expectingPageErrors(test);
 *   await page.goto("/page-that-throws");
 *   expect(pageErrors).toContainEqual(expect.stringContaining("Expected error"));
 * });
 * ```
 */
export function expectingPageErrors(t: typeof test): void {
  t.info().annotations.push({ type: "expectPageErrors", description: "true" });
}

/**
 * Assert that specific page errors occurred.
 * Use this after calling expectingPageErrors() to verify expected errors.
 *
 * @example
 * ```typescript
 * test("handles error gracefully", async ({ page, pageErrors }) => {
 *   expectingPageErrors(test);
 *   await page.goto("/page-that-throws");
 *   assertPageErrors(pageErrors, [/Expected error/i]);
 * });
 * ```
 */
export function assertPageErrors(
  pageErrors: string[],
  expectedPatterns: RegExp[]
): void {
  for (const pattern of expectedPatterns) {
    const found = pageErrors.some((error) => pattern.test(error));
    if (!found) {
      throw new Error(
        `Expected page error matching ${pattern} but got:\n${
          pageErrors.length > 0
            ? pageErrors.map((e) => `  - ${e}`).join("\n")
            : "  (no errors)"
        }`
      );
    }
  }
}
