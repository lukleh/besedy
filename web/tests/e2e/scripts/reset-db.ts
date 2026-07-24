/**
 * Reset the test database
 *
 * Drops all tables and re-runs schema push + seed.
 * Used before each test run for a clean slate.
 *
 * Runs Prisma commands from HOST (production image has no Prisma CLI).
 */

import { execSync } from "child_process";
import { resolveScriptEnvFilePath } from "../../../src/lib/script-env";

const TEST_DB_URL =
  "postgresql://besedy_test:besedy_test@localhost:5434/besedy_test";
const TEST_ENV_FILE = resolveScriptEnvFilePath("test");

function runCommand(
  cmd: string,
  description: string,
  env?: NodeJS.ProcessEnv
): void {
  console.log(`${description}...`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: process.cwd(), env });
    console.log(`  Done!\n`);
  } catch (error) {
    console.error(`  Failed: ${error}`);
    throw error;
  }
}

async function main(): Promise<void> {
  console.log("=== Resetting Test Database ===\n");

  if (!TEST_ENV_FILE) {
    throw new Error(
      "Test env file not found. Set BESEDY_WEB_ENV_TEST or copy web/.env.test.example to ~/.config/lukleh/besedy/web.env.test."
    );
  }

  // Drop and recreate schema (runs in container)
  runCommand(
    `docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "${TEST_ENV_FILE}" exec -T db psql -U besedy_test -d besedy_test -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`,
    "[1/3] Dropping existing schema"
  );

  // Push schema from HOST (production image has no Prisma CLI)
  runCommand(
    "npx prisma db push --accept-data-loss",
    "[2/3] Pushing schema from host",
    { ...process.env, DATABASE_URL: TEST_DB_URL }
  );

  // Run test seed from HOST (production image has no tsx)
  runCommand("npx tsx prisma/seed-test.ts", "[3/3] Seeding test data", {
    ...process.env,
    DATABASE_URL: TEST_DB_URL,
  });

  console.log("=== Database reset complete ===\n");
}

main().catch((error) => {
  console.error("Reset failed:", error);
  process.exit(1);
});
