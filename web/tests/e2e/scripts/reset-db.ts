/**
 * Reset the test database
 *
 * Drops all tables and re-runs schema push + seed.
 * Used before each test run for a clean slate.
 *
 * Runs Prisma commands from HOST (production image has no Prisma CLI).
 */

import { execSync } from "child_process";
const TEST_DB_URL =
  "postgresql://besedy_test:besedy_test@localhost:5434/besedy_test";

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

  // Drop and recreate schema (runs in container)
  runCommand(
    'bash ../scripts/run_web_compose.sh test exec -T db psql -U besedy_test -d besedy_test -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"',
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
