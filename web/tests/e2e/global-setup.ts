/**
 * Playwright Global Setup
 *
 * Runs before all E2E tests to:
 * 1. Verify Docker containers are running (fails fast if not)
 * 2. Wait for services to be healthy
 * 3. Generate test fixtures if needed (audio, catalogs, transcripts)
 *
 * NOTE: Docker lifecycle and DB setup are handled by `just test-up`.
 * Run `just test-up` before running tests.
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs/promises";
import { TEST_AUDIO_FILES } from "../../prisma/test-data";

const TEST_WEB_URL = "http://localhost:3002";
const MAX_RETRIES = 60;
const RETRY_DELAY = 2000;
const TEST_COMPOSE_INSTANCE = process.env.BESEDY_WEB_COMPOSE_INSTANCE ?? "test";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyContainersRunning(): Promise<void> {
  console.log("Verifying test containers are running...");

  try {
    const result = execSync(
      "bash ../scripts/run_web_compose.sh test ps --format json",
      { encoding: "utf-8", cwd: process.cwd() }
    );

    const hasDb = result.includes(`besedy-${TEST_COMPOSE_INSTANCE}-db`);
    const hasWeb = result.includes(`besedy-${TEST_COMPOSE_INSTANCE}-web`);

    if (!hasDb || !hasWeb) {
      const missing = [
        !hasDb && "db",
        !hasWeb && "web",
      ]
        .filter(Boolean)
        .join(", ");

      throw new Error(
        `Test containers not running (missing: ${missing}).\n\n` +
          `Run 'just test-up' first to start the test environment.`
      );
    }

    console.log("  All containers running");
  } catch (error) {
    if (error instanceof Error && error.message.includes("not running")) {
      throw error;
    }
    throw new Error(
      "Test containers not running.\n\n" +
        "Run 'just test-up' first to start the test environment."
    );
  }
}

async function waitForDatabase(): Promise<void> {
  console.log("Waiting for database...");
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      execSync(
        "bash ../scripts/run_web_compose.sh test exec -T db pg_isready -U besedy_test",
        { stdio: "ignore", cwd: process.cwd() }
      );
      console.log("  Database is ready!");
      return;
    } catch {
      await sleep(RETRY_DELAY);
    }
  }
  throw new Error("Database failed to become ready within timeout");
}

async function generateFixtures(): Promise<void> {
  const fixturesDir = path.join(__dirname, "fixtures");
  const catalogPath = path.join(fixturesDir, "audio_catalog_test.csv");
  const audioDir = path.join(fixturesDir, "audio");

  // Check if fixtures already exist and match expected hashes
  try {
    await fs.access(catalogPath);
    const catalog = await fs.readFile(catalogPath, "utf-8");
    const expectedFile = TEST_AUDIO_FILES[0];
    const expectedHash = expectedFile?.hash;
    const expectedWav = expectedFile?.filename
      ? path.join(audioDir, expectedFile.filename)
      : undefined;
    const expectedCompressed = expectedHash
      ? path.join(audioDir, "compressed", `${expectedHash}.webm`)
      : undefined;

    if (
      expectedHash &&
      catalog.includes(expectedHash) &&
      expectedWav &&
      expectedCompressed
    ) {
      const [wavOk, compressedOk] = await Promise.all([
        fs
          .access(expectedWav)
          .then(() => true)
          .catch(() => false),
        fs
          .access(expectedCompressed)
          .then(() => true)
          .catch(() => false),
      ]);
      if (wavOk && compressedOk) {
        console.log("Fixtures already exist, skipping generation...");
        return;
      }
    }
    if (expectedHash) {
      console.log("Fixtures exist but are outdated, regenerating...");
      await fs.rm(audioDir, { recursive: true, force: true });
    }
  } catch {
    // Fixtures don't exist, generate them
  }

  console.log("Generating test fixtures...");
  execSync("npm run test:e2e:generate", {
    stdio: "inherit",
    cwd: process.cwd(),
  });
}

async function ensureFixturePermissions(): Promise<void> {
  // Ensure fixture files are readable by container user (nextjs/1001)
  // The container mounts fixtures as read-only, but files must be world-readable
  const fixturesDir = path.join(__dirname, "fixtures");

  console.log("Ensuring fixture permissions...");
  try {
    // Make all files in fixtures directory readable (chmod -R a+r)
    execSync(`chmod -R a+rX "${fixturesDir}"`, { stdio: "inherit" });
  } catch (error) {
    console.warn("  Warning: Could not set fixture permissions:", error);
  }
}

async function waitForWebServer(): Promise<void> {
  console.log("Waiting for web server...");
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await fetch(`${TEST_WEB_URL}/api/health`);
      if (response.ok) {
        console.log("  Web server is ready!");
        return;
      }
    } catch {
      // Server not ready yet
    }
    await sleep(RETRY_DELAY);
  }
  throw new Error("Web server failed to become ready within timeout");
}

async function globalSetup(): Promise<void> {
  console.log("\n=== Playwright Global Setup ===\n");

  const startTime = Date.now();

  try {
    // 1. Verify containers are running (fail fast if not)
    await verifyContainersRunning();

    // 2. Wait for services to be healthy
    await waitForDatabase();

    // 3. Generate fixtures (if needed) and ensure permissions
    await generateFixtures();
    await ensureFixturePermissions();

    // 4. Wait for web server
    await waitForWebServer();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Setup complete in ${elapsed}s ===\n`);
  } catch (error) {
    console.error("\nSetup failed:", error);
    throw error;
  }
}

export default globalSetup;
