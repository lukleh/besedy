/**
 * Playwright Global Teardown
 *
 * Runs after all E2E tests complete.
 * By default, keeps containers running for faster subsequent runs.
 * Set TEARDOWN_CONTAINERS=true to stop containers after tests.
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs/promises";
import { resolveScriptEnvFilePath } from "../../src/lib/script-env";

const TEST_ENV_FILE = resolveScriptEnvFilePath("test");

function requireTestEnvFile(): string {
  if (!TEST_ENV_FILE) {
    throw new Error(
      "Test env file not found. Set BESEDY_WEB_ENV_TEST or copy web/.env.test.example to ~/.config/lukleh/besedy/web.env.test."
    );
  }
  return TEST_ENV_FILE;
}

async function cleanupFixtures(): Promise<void> {
  // Optionally clean up generated fixtures
  // By default, we keep them for faster subsequent runs
  if (process.env.TEARDOWN_FIXTURES === "true") {
    const fixturesDir = path.join(__dirname, "fixtures");
    try {
      await fs.rm(fixturesDir, { recursive: true, force: true });
      console.log("Cleaned up fixtures directory");
    } catch {
      // Directory might not exist
    }
  }
}

async function stopContainers(): Promise<void> {
  if (process.env.TEARDOWN_CONTAINERS === "true") {
    console.log("Stopping Docker containers...");
    execSync(`docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "${requireTestEnvFile()}" down`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  }

  if (process.env.TEARDOWN_VOLUMES === "true") {
    console.log("Removing Docker volumes...");
    execSync(`docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "${requireTestEnvFile()}" down -v`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  }
}

async function globalTeardown(): Promise<void> {
  console.log("\n=== Playwright Global Teardown ===\n");

  try {
    await cleanupFixtures();
    await stopContainers();

    if (!process.env.TEARDOWN_CONTAINERS && !process.env.TEARDOWN_VOLUMES) {
      console.log("Containers kept running for faster subsequent runs.");
      console.log("To stop: npm run test:e2e:teardown");
      console.log("To stop and clean: npm run test:e2e:teardown:clean");
    }

    console.log("\n=== Teardown complete ===\n");
  } catch (error) {
    console.error("Teardown error:", error);
    // Don't throw - teardown errors shouldn't fail the test run
  }
}

export default globalTeardown;
