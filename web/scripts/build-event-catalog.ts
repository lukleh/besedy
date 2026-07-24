#!/usr/bin/env tsx

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { deriveEventTitle, parseDurationHmsToSeconds } from "../src/lib/catalog-events/utils";
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

interface CandidateRecording {
  audioHash: string;
  durationHms: string | null;
  locationId: number;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  verified: boolean;
}

interface GroupSummary {
  catalogId: string;
  candidates: number;
  groupsDiscovered: number;
  eventsCreated: number;
  recordingsAssignedToNewEvents: number;
  recordingsAssignedToExistingEvents: number;
  recordingsSkippedAmbiguousExistingEvents: number;
  unassignedActionable: number;
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
        "Usage: npx tsx scripts/build-event-catalog.ts --catalog <id> --user <userId> [--dry-run] [--prod]"
      );
      console.log(
        "   or: npx tsx scripts/build-event-catalog.ts --all --user <userId> [--dry-run] [--prod]"
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

function buildEventKey(
  locationId: number,
  dateYear: number,
  dateMonth: number | null,
  dateDay: number | null
): string {
  return `${locationId}|${dateYear}|${dateMonth ?? 0}|${dateDay ?? 0}`;
}

function pickPrimaryAudioHash(rows: CandidateRecording[]): string {
  return rows
    .slice()
    .sort((a, b) => {
      if (a.verified !== b.verified) {
        return a.verified ? -1 : 1;
      }
      const durationDelta =
        parseDurationHmsToSeconds(b.durationHms) - parseDurationHmsToSeconds(a.durationHms);
      if (durationDelta !== 0) {
        return durationDelta;
      }
      return a.audioHash.localeCompare(b.audioHash);
    })[0].audioHash;
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

async function countUnassignedActionable(prisma: PrismaClient, catalogId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number | bigint | string }>>`
    SELECT COUNT(*) AS count
    FROM catalog_entry ce
    WHERE ce.workflow_group_id = ${catalogId}
      AND ce.is_actionable = true
      AND NOT EXISTS (
        SELECT 1
        FROM catalog_event_recording cer
        WHERE cer.workflow_group_id = ce.workflow_group_id
          AND cer.audio_hash = ce.audio_hash
      )
  `;
  const value = rows[0]?.count ?? 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.parseInt(String(value), 10);
}

async function fetchCandidateRecordings(
  prisma: PrismaClient,
  catalogId: string
): Promise<CandidateRecording[]> {
  return prisma.$queryRaw<CandidateRecording[]>`
    SELECT
      ce.audio_hash AS "audioHash",
      ce.duration_hms AS "durationHms",
      am.location_id AS "locationId",
      am.date_year AS "dateYear",
      am.date_month AS "dateMonth",
      am.date_day AS "dateDay",
      am.verified AS "verified"
    FROM catalog_entry ce
    LEFT JOIN audio_metadata am
      ON am.workflow_group_id = ce.workflow_group_id
     AND am.audio_hash = ce.audio_hash
    WHERE ce.workflow_group_id = ${catalogId}
      AND ce.is_actionable = true
      AND am.location_id IS NOT NULL
      AND am.date_year IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM catalog_event_recording cer
        WHERE cer.workflow_group_id = ce.workflow_group_id
          AND cer.audio_hash = ce.audio_hash
      )
    ORDER BY am.location_id, am.date_year, am.date_month, am.date_day, ce.audio_hash
  `;
}

async function processCatalog(
  prisma: PrismaClient,
  catalogId: string,
  userId: string,
  dryRun: boolean
): Promise<GroupSummary> {
  const [candidates, existingEvents] = await Promise.all([
    fetchCandidateRecordings(prisma, catalogId),
    prisma.catalogEvent.findMany({
      where: { workflowGroupId: catalogId },
      select: { id: true, locationId: true, dateYear: true, dateMonth: true, dateDay: true },
    }),
  ]);

  const grouped = new Map<string, CandidateRecording[]>();
  for (const row of candidates) {
    const key = buildEventKey(row.locationId, row.dateYear, row.dateMonth, row.dateDay);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  const existingEventsByKey = new Map<string, typeof existingEvents>();
  for (const event of existingEvents) {
    const key = buildEventKey(event.locationId, event.dateYear, event.dateMonth, event.dateDay);
    const bucket = existingEventsByKey.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      existingEventsByKey.set(key, [event]);
    }
  }

  const locationIds = Array.from(new Set(candidates.map((row) => row.locationId)));
  const locationRows =
    locationIds.length > 0
      ? await prisma.location.findMany({
          where: { id: { in: locationIds } },
          select: { id: true, name: true },
        })
      : [];
  const locationNameById = new Map(locationRows.map((row) => [row.id, row.name]));

  let eventsCreated = 0;
  let recordingsAssignedToNewEvents = 0;
  let recordingsAssignedToExistingEvents = 0;
  let recordingsSkippedAmbiguousExistingEvents = 0;

  for (const [key, rows] of grouped) {
    const first = rows[0];
    const existingForKey = existingEventsByKey.get(key) ?? [];
    if (existingForKey.length > 0) {
      recordingsSkippedAmbiguousExistingEvents += rows.length;
      continue;
    }

    let eventId: number | null = null;
    eventsCreated += 1;
    if (!dryRun) {
      const locationName =
        locationNameById.get(first.locationId) ?? `Location ${first.locationId}`;
      const createdEvent = await prisma.catalogEvent.create({
        data: {
          workflowGroupId: catalogId,
          title: deriveEventTitle(
            locationName,
            first.dateYear,
            first.dateMonth ?? null,
            first.dateDay ?? null
          ),
          locationId: first.locationId,
          dateYear: first.dateYear,
          dateMonth: first.dateMonth ?? null,
          dateDay: first.dateDay ?? null,
          sessionIndex: 1,
          released: false,
          createdById: userId,
          updatedById: userId,
        },
        select: { id: true },
      });
      eventId = createdEvent.id;
    }

    recordingsAssignedToNewEvents += rows.length;

    if (!dryRun && eventId !== null) {
      const primaryAudioHash = pickPrimaryAudioHash(rows);
      await prisma.catalogEventRecording.createMany({
        data: rows.map((row) => ({
          eventId,
          workflowGroupId: catalogId,
          audioHash: row.audioHash,
          isPrimary: primaryAudioHash === row.audioHash,
        })),
        skipDuplicates: true,
      });
      existingEventsByKey.set(key, [
        {
          id: eventId,
          locationId: first.locationId,
          dateYear: first.dateYear,
          dateMonth: first.dateMonth,
          dateDay: first.dateDay,
        },
      ]);
    }
  }

  const unassignedActionable = await countUnassignedActionable(prisma, catalogId);

  return {
    catalogId,
    candidates: candidates.length,
    groupsDiscovered: grouped.size,
    eventsCreated,
    recordingsAssignedToNewEvents,
    recordingsAssignedToExistingEvents,
    recordingsSkippedAmbiguousExistingEvents,
    unassignedActionable,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const mode = args.prod ? "production" : "development";
  const envFilePath = loadScriptEnv(mode);
  if (envFilePath) {
    console.log(`[build-event-catalog] Loaded environment from ${envFilePath}`);
  }

  const connectionString = getDatabaseUrlOrThrow();
  console.log(`[build-event-catalog] Database: ${redactDatabaseUrl(connectionString)}`);
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    await validateUser(prisma, args.userId);

    const catalogs = args.all
      ? await prisma.workflowGroup.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
        })
      : await prisma.workflowGroup.findMany({
          where: { id: args.catalogId ?? undefined },
          select: { id: true },
        });

    if (catalogs.length === 0) {
      throw new Error(args.catalogId ? `Catalog not found: ${args.catalogId}` : "No catalogs found");
    }

    console.log(
      `[build-event-catalog] mode=${args.prod ? "production" : "development"} dryRun=${args.dryRun} catalogs=${catalogs.length}`
    );

    const summaries: GroupSummary[] = [];
    for (const catalog of catalogs) {
      const summary = await processCatalog(prisma, catalog.id, args.userId, args.dryRun);
      summaries.push(summary);
      console.log(
        `[build-event-catalog] ${catalog.id} candidates=${summary.candidates} groups=${summary.groupsDiscovered} created=${summary.eventsCreated} assigned_new=${summary.recordingsAssignedToNewEvents} assigned_existing=${summary.recordingsAssignedToExistingEvents} skipped_existing_ambiguous=${summary.recordingsSkippedAmbiguousExistingEvents} unassigned_actionable=${summary.unassignedActionable}`
      );
    }

    const totals = summaries.reduce(
      (acc, summary) => {
        acc.candidates += summary.candidates;
        acc.groupsDiscovered += summary.groupsDiscovered;
        acc.eventsCreated += summary.eventsCreated;
        acc.recordingsAssignedToNewEvents += summary.recordingsAssignedToNewEvents;
        acc.recordingsAssignedToExistingEvents += summary.recordingsAssignedToExistingEvents;
        acc.recordingsSkippedAmbiguousExistingEvents +=
          summary.recordingsSkippedAmbiguousExistingEvents;
        acc.unassignedActionable += summary.unassignedActionable;
        return acc;
      },
      {
        candidates: 0,
        groupsDiscovered: 0,
        eventsCreated: 0,
        recordingsAssignedToNewEvents: 0,
        recordingsAssignedToExistingEvents: 0,
        recordingsSkippedAmbiguousExistingEvents: 0,
        unassignedActionable: 0,
      }
    );

    console.log("[build-event-catalog] totals", totals);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[build-event-catalog] failed:", error);
  process.exit(1);
});
