import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { resolveBesedyWebStateDir } from "./src/lib/runtime-paths";

/**
 * E2E Test Configuration
 *
 * Uses unified docker-compose.yml with the resolved test env file on port 3002.
 * Global setup handles container startup, DB seeding, and fixture generation.
 *
 * See https://playwright.dev/docs/test-configuration
 */

// Generate timestamp for isolated test results (YYYYMMDD_HHMMSS)
// Use TEST_RUN_ID env var if set (to ensure one directory per test run),
// otherwise generate new timestamp and set env var for child processes
const timestamp =
  process.env.TEST_RUN_ID ||
  (() => {
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\..+/, "")
      .replace(/(\d{8})(\d{6})/, "$1_$2");
    process.env.TEST_RUN_ID = ts;
    return ts;
  })();

// All test output goes under one timestamped folder
const testOutputDir = path.join(
  resolveBesedyWebStateDir("test-output"),
  timestamp
);

export default defineConfig({
  testDir: "./tests/e2e",
  /* Timeouts for cold start + navigation */
  timeout: 45000, // 45s per test (allows for cold start + navigation)
  expect: {
    timeout: 10000, // 10s for assertions
    toHaveScreenshot: {
      maxDiffPixels: 100,
      threshold: 0.2,
      animations: "disabled", // Disable animations for consistent screenshots
    },
  },
  /* Snapshot paths for visual regression tests */
  snapshotPathTemplate: "{testDir}/snapshots/{testFilePath}/{arg}{ext}",
  /* Global setup/teardown for test environment */
  globalSetup: require.resolve("./tests/e2e/global-setup"),
  globalTeardown: require.resolve("./tests/e2e/global-teardown"),
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Limit parallelism to reduce DB mutation races in E2E */
  /* CI: 1 worker (sequential), Local: 4 workers max */
  workers: process.env.CI ? 1 : 4,
  /* Output directories - all under timestamped folder */
  outputDir: `${testOutputDir}/artifacts`,
  /* Reporter to use */
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: `${testOutputDir}/report` }],
    ["json", { outputFile: `${testOutputDir}/results.json` }],
  ],
  /* Shared settings for all the projects below */
  use: {
    /* Base URL - uses test environment on port 3002 */
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3002",
    /* Collect trace when retrying the failed test */
    trace: "on-first-retry",
    /* Take screenshot on failure */
    screenshot: "only-on-failure",
    /* Action and navigation timeouts */
    actionTimeout: 10000, // 10s for clicks, fills
    navigationTimeout: 30000, // 30s for page loads (cold start can be slow)
  },

  /**
   * Configure projects for browsers and devices.
   *
   * Current coverage: Chrome-based browsers only (Desktop + Android devices)
   * - Desktop Chrome: Standard desktop testing
   * - Galaxy Tab S4: Tablet viewport testing
   * - Pixel 7: Mobile viewport testing
   *
   * Not included: Firefox, WebKit/Safari, iOS
   * Rationale: Chrome has ~65% market share. Firefox/Safari can be added
   * if cross-browser issues are reported. iOS requires macOS for Playwright.
   */
  projects: [
    {
      name: "Desktop Chrome",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "Galaxy Tab S4",
      use: { ...devices["Galaxy Tab S4"] },
    },
    {
      name: "Pixel 7",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "iPhone 14",
      use: {
        ...devices["iPhone 14"],
        hasTouch: true,
        isMobile: true,
      },
    },
  ],

  /* Don't use built-in webServer - globalSetup handles Docker containers */
});
