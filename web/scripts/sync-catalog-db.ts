#!/usr/bin/env tsx
import { syncActiveCatalogs, syncCatalogGroup } from "../src/lib/catalog-sync";

function parseArgs(argv: string[]): { force: boolean; groupId: string | null } {
  let force = false;
  let groupId: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--group" || arg === "-g") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --group");
      }
      groupId = value;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: npx tsx scripts/sync-catalog-db.ts [--force] [--group <YYYYMMDD_HHMMSS>]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { force, groupId };
}

async function main() {
  const { force, groupId } = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  console.log(
    `[sync-catalog-db] Starting sync at ${startedAt.toISOString()} (force=${force}, groupId=${groupId ?? "ALL"})`
  );

  const results = groupId
    ? [await syncCatalogGroup(groupId, { force })]
    : await syncActiveCatalogs({ force });

  const finishedAt = new Date();
  const totals = {
    all: results.length,
    success: results.filter((result) => result.status === "success").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    error: results.filter((result) => result.status === "error").length,
  };

  console.log("[sync-catalog-db] Finished", {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totals,
  });

  for (const result of results) {
    console.log(
      `[sync-catalog-db] ${result.groupId}: status=${result.status} changedSources=${result.changedSources.join(",") || "-"}`
    );
    if (result.error) {
      console.error(`[sync-catalog-db] ${result.groupId} error: ${result.error}`);
    }
  }

  if (totals.error > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[sync-catalog-db] Fatal error:", error);
  process.exit(1);
});
