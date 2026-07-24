#!/usr/bin/env tsx

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { ensureSingleRecordingEventState } from "../src/lib/catalog-events/single-recording";
import {
  getDatabaseUrlOrThrow,
  loadScriptEnv,
  redactDatabaseUrl,
} from "../src/lib/script-env";

interface Args {
  catalogId: string | null;
  all: boolean;
  userId: string;
  dryRun: boolean;
  prod: boolean;
}

interface CatalogSummary {
  catalogId: string;
  candidates: number;
  normalized: number;
}

function parseArgs(argv: string[]): Args {
  let catalogId: string | null = null;
  let all = false;
  let userId: string | null = null;
  let dryRun = false;
  let prod = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--catalog") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --catalog");
      catalogId = value;
      i += 1;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--user") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --user");
      userId = value;
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--prod") {
      prod = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/normalize-single-recording-events.ts --catalog <id> --user <userId> [--dry-run] [--prod]"
      );
      console.log(
        "   or: npx tsx scripts/normalize-single-recording-events.ts --all --user <userId> [--dry-run] [--prod]"
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!catalogId && !all) {
    throw new Error("Provide --catalog <id> or --all");
  }
  if (catalogId && all) {
    throw new Error("Use either --catalog or --all, not both");
  }
  if (!userId) {
    throw new Error("--user is required");
  }

  return { catalogId, all, userId, dryRun, prod };
}

async function validateUser(prisma: PrismaClient, userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isAdmin: true, isSuperadmin: true, status: true },
  });

  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }
  if (user.status !== "ACTIVE") {
    throw new Error(`User is not ACTIVE: ${userId}`);
  }
  if (!user.isAdmin && !user.isSuperadmin) {
    throw new Error(`User must be admin/superadmin: ${userId}`);
  }
}

async function getTargetCatalogIds(prisma: PrismaClient, args: Args): Promise<string[]> {
  if (args.catalogId) {
    const group = await prisma.workflowGroup.findFirst({
      where: { id: args.catalogId, isActive: true },
      select: { id: true },
    });
    if (!group) {
      throw new Error(`Active catalog not found: ${args.catalogId}`);
    }
    return [group.id];
  }

  const groups = await prisma.workflowGroup.findMany({
    where: { isActive: true },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return groups.map((group) => group.id);
}

async function findCandidateEventIds(
  prisma: PrismaClient,
  catalogId: string
): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ eventId: number }>>`
    SELECT e.id AS "eventId"
    FROM catalog_event e
    JOIN catalog_event_recording cer
      ON cer.event_id = e.id
     AND cer.workflow_group_id = e.workflow_group_id
    WHERE e.workflow_group_id = ${catalogId}
    GROUP BY e.id, e.released
    HAVING COUNT(*) = 1
       AND (BOOL_OR(cer.is_primary) = false OR e.released = false)
    ORDER BY e.id
  `;

  return rows.map((row) => row.eventId);
}

async function processCatalog(
  prisma: PrismaClient,
  catalogId: string,
  userId: string,
  dryRun: boolean
): Promise<CatalogSummary> {
  const eventIds = await findCandidateEventIds(prisma, catalogId);

  if (dryRun) {
    return {
      catalogId,
      candidates: eventIds.length,
      normalized: 0,
    };
  }

  let normalized = 0;
  for (const eventId of eventIds) {
    if (await ensureSingleRecordingEventState(prisma, catalogId, eventId, userId)) {
      normalized += 1;
    }
  }

  return {
    catalogId,
    candidates: eventIds.length,
    normalized,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.prod ? "production" : "development";
  const envFile = loadScriptEnv(mode);
  const connectionString = getDatabaseUrlOrThrow();

  console.log(`[normalize-single-recording-events] Mode: ${mode}`);
  if (envFile) {
    console.log(`[normalize-single-recording-events] Loaded environment from: ${envFile}`);
  }
  console.log(
    `[normalize-single-recording-events] Connecting to database: ${redactDatabaseUrl(connectionString)}`
  );

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    await validateUser(prisma, args.userId);

    const catalogIds = await getTargetCatalogIds(prisma, args);
    const summaries: CatalogSummary[] = [];

    for (const catalogId of catalogIds) {
      const summary = await processCatalog(prisma, catalogId, args.userId, args.dryRun);
      summaries.push(summary);
      console.log(
        `[normalize-single-recording-events] ${catalogId} candidates=${summary.candidates} normalized=${summary.normalized}`
      );
    }

    const totals = summaries.reduce(
      (acc, summary) => ({
        candidates: acc.candidates + summary.candidates,
        normalized: acc.normalized + summary.normalized,
      }),
      { candidates: 0, normalized: 0 }
    );

    if (args.dryRun) {
      console.log(
        `[normalize-single-recording-events] Dry run complete. candidates=${totals.candidates}`
      );
    } else {
      console.log(
        `[normalize-single-recording-events] Done. candidates=${totals.candidates} normalized=${totals.normalized}`
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[normalize-single-recording-events] Failed:", error);
  process.exitCode = 1;
});
