#!/usr/bin/env tsx

import fs from "fs/promises";
import type { Dirent } from "fs";
import path from "path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { getPostersDir, getSourcesDir } from "../src/lib/config";
import {
  getDatabaseUrlOrThrow,
  loadScriptEnv,
  redactDatabaseUrl,
} from "../src/lib/script-env";

const POSTER_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;
const POSTER_META_FILENAME = "poster_meta.json";

type PosterVariant = "portrait" | "landscape";

interface Args {
  catalogId: string | null;
  all: boolean;
  dryRun: boolean;
  prod: boolean;
  yes: boolean;
}

interface CatalogSummary {
  catalogId: string;
  eventsTotal: number;
  eventsProcessed: number;
  eventsSkippedNoPrimary: number;
  eventsSkippedMultiplePrimary: number;
  skippedEventIds: number[];
  movedPosterVariants: number;
  movedSourceDirs: number;
  clearedEventPosterData: number;
  clearedEventSourceDirs: number;
  unassignedHashes: number;
  preservedLegacyHashes: number;
  deletedLegacySourceDirs: number;
  deletedLegacyPosterDirs: number;
}

interface EventMigrationResult {
  movedPosterVariants: number;
  movedSourceDir: boolean;
  clearedEventPosterData: boolean;
  clearedEventSourceDir: boolean;
}

function parseArgs(argv: string[]): Args {
  let catalogId: string | null = null;
  let all = false;
  let dryRun = false;
  let prod = false;
  let yes = false;

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
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--prod") {
      prod = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: npx tsx scripts/migrate-recording-assets-to-events.ts --catalog <id> [--dry-run] [--prod] [--yes]");
      console.log("   or: npx tsx scripts/migrate-recording-assets-to-events.ts --all [--dry-run] [--prod] [--yes]");
      console.log("");
      console.log("Destructive behavior:");
      console.log("- Moves poster/sources assets from PRIMARY recording to event");
      console.log("- Deletes all remaining legacy recording-scoped asset directories");
      console.log("- Keeps legacy directories only for events skipped due to invalid primary assignment");
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

  return { catalogId, all, dryRun, prod, yes };
}

function resolveLegacyPosterDir(postersRoot: string, hash: string): string {
  const prefix = hash.slice(0, 8).toLowerCase();
  return path.join(postersRoot, prefix);
}

function resolveEventPosterDir(postersRoot: string, eventId: number): string {
  return path.join(postersRoot, "events", String(eventId));
}

function resolveLegacySourcesDir(sourcesRoot: string, hash: string): string {
  return path.join(sourcesRoot, hash);
}

function resolveEventSourcesDir(sourcesRoot: string, eventId: number): string {
  return path.join(sourcesRoot, "events", String(eventId));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function safeReaddir(targetPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }
}

async function removeDirectoryIfEmpty(dirPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(dirPath);
    if (entries.length === 0) {
      await fs.rmdir(dirPath);
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EXDEV") throw err;

    await fs.copyFile(sourcePath, destinationPath);
    await fs.unlink(sourcePath);
  }
}

async function moveDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationDir), { recursive: true });
  try {
    await fs.rename(sourceDir, destinationDir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EXDEV") throw err;

    await fs.cp(sourceDir, destinationDir, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  }
}

async function findPosterFileInDir(
  dirPath: string,
  variant: PosterVariant
): Promise<string | null> {
  const base = `poster_${variant}`;
  for (const ext of POSTER_EXTENSIONS) {
    const candidate = path.join(dirPath, `${base}${ext}`);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function removePosterVariantFiles(
  dirPath: string,
  variant: PosterVariant
): Promise<void> {
  const base = `poster_${variant}`;
  await Promise.all(
    POSTER_EXTENSIONS.map((ext) => removeFileIfExists(path.join(dirPath, `${base}${ext}`)))
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function hasAnyPosterData(eventPosterDir: string): Promise<boolean> {
  if (!(await dirExists(eventPosterDir))) return false;
  const [portrait, landscape, metaExists] = await Promise.all([
    findPosterFileInDir(eventPosterDir, "portrait"),
    findPosterFileInDir(eventPosterDir, "landscape"),
    pathExists(path.join(eventPosterDir, POSTER_META_FILENAME)),
  ]);
  return !!portrait || !!landscape || metaExists;
}

async function migrateEventPosters(
  postersRoot: string,
  eventId: number,
  primaryHash: string,
  dryRun: boolean
): Promise<{ movedVariants: number; clearedEventData: boolean }> {
  const legacyPosterDir = resolveLegacyPosterDir(postersRoot, primaryHash);
  const eventPosterDir = resolveEventPosterDir(postersRoot, eventId);
  const eventMetaPath = path.join(eventPosterDir, POSTER_META_FILENAME);

  const sourcePortrait = await findPosterFileInDir(legacyPosterDir, "portrait");
  const sourceLandscape = await findPosterFileInDir(legacyPosterDir, "landscape");
  const sourceHasData = !!sourcePortrait || !!sourceLandscape;
  const eventHadData = await hasAnyPosterData(eventPosterDir);

  // Reruns must not wipe already-migrated event posters when legacy files are gone.
  if (!sourceHasData) {
    return { movedVariants: 0, clearedEventData: false };
  }

  let movedVariants = 0;

  if (!dryRun) {
    await fs.mkdir(eventPosterDir, { recursive: true });
    await removePosterVariantFiles(eventPosterDir, "portrait");
    await removePosterVariantFiles(eventPosterDir, "landscape");
    await removeFileIfExists(eventMetaPath);
  }

  const sourceMeta = await readJsonFile(path.join(legacyPosterDir, POSTER_META_FILENAME));
  const nextMeta: Record<string, unknown> = {};

  for (const [variant, sourcePath] of [
    ["portrait", sourcePortrait],
    ["landscape", sourceLandscape],
  ] as const) {
    if (!sourcePath) continue;

    const ext = path.extname(sourcePath).toLowerCase();
    const destinationPath = path.join(eventPosterDir, `poster_${variant}${ext}`);

    if (!dryRun) {
      await moveFile(sourcePath, destinationPath);
    }

    movedVariants += 1;

    const metaValue = sourceMeta?.[variant];
    if (isObjectRecord(metaValue)) {
      nextMeta[variant] = metaValue;
    }
  }

  if (!dryRun) {
    if (Object.keys(nextMeta).length > 0) {
      await fs.writeFile(eventMetaPath, JSON.stringify(nextMeta, null, 2));
    } else {
      await removeFileIfExists(eventMetaPath);
    }

    await removeDirectoryIfEmpty(eventPosterDir);
  }

  return {
    movedVariants,
    clearedEventData: eventHadData,
  };
}

async function migrateEventSources(
  sourcesRoot: string,
  eventId: number,
  primaryHash: string,
  dryRun: boolean
): Promise<{ movedSourceDir: boolean; clearedEventSourceDir: boolean }> {
  const legacySourcesDir = resolveLegacySourcesDir(sourcesRoot, primaryHash);
  const eventSourcesDir = resolveEventSourcesDir(sourcesRoot, eventId);

  const sourceExists = await dirExists(legacySourcesDir);
  const eventExists = await dirExists(eventSourcesDir);

  if (!sourceExists && !eventExists) {
    return { movedSourceDir: false, clearedEventSourceDir: false };
  }

  // Reruns must not remove event sources when there is no legacy dir left to move.
  if (!sourceExists) {
    return { movedSourceDir: false, clearedEventSourceDir: false };
  }

  if (!dryRun) {
    if (eventExists) {
      await fs.rm(eventSourcesDir, { recursive: true, force: true });
    }

    await moveDirectory(legacySourcesDir, eventSourcesDir);
  }

  return {
    movedSourceDir: true,
    clearedEventSourceDir: eventExists,
  };
}

async function migrateEventAssets(
  postersRoot: string,
  sourcesRoot: string,
  eventId: number,
  primaryHash: string,
  dryRun: boolean
): Promise<EventMigrationResult> {
  const [posterResult, sourceResult] = await Promise.all([
    migrateEventPosters(postersRoot, eventId, primaryHash, dryRun),
    migrateEventSources(sourcesRoot, eventId, primaryHash, dryRun),
  ]);

  return {
    movedPosterVariants: posterResult.movedVariants,
    movedSourceDir: sourceResult.movedSourceDir,
    clearedEventPosterData: posterResult.clearedEventData,
    clearedEventSourceDir: sourceResult.clearedEventSourceDir,
  };
}

async function cleanupLegacySourceDirs(
  sourcesRoot: string,
  preserveHashes: Set<string>,
  dryRun: boolean
): Promise<number> {
  const entries = await safeReaddir(sourcesRoot);
  let deleted = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "events") continue;
    if (preserveHashes.has(entry.name)) continue;

    if (!dryRun) {
      await fs.rm(path.join(sourcesRoot, entry.name), { recursive: true, force: true });
    }
    deleted += 1;
  }

  return deleted;
}

async function cleanupLegacyPosterDirs(
  postersRoot: string,
  preservePrefixes: Set<string>,
  dryRun: boolean
): Promise<number> {
  const entries = await safeReaddir(postersRoot);
  let deleted = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "events") continue;

    const prefix = entry.name.toLowerCase();
    if (preservePrefixes.has(prefix)) continue;

    if (!dryRun) {
      await fs.rm(path.join(postersRoot, entry.name), { recursive: true, force: true });
    }
    deleted += 1;
  }

  return deleted;
}

async function processCatalog(
  prisma: PrismaClient,
  postersBaseDir: string,
  sourcesBaseDir: string,
  catalogId: string,
  dryRun: boolean
): Promise<CatalogSummary> {
  const postersRoot = path.join(postersBaseDir, `posters_${catalogId}`);
  const sourcesRoot = path.join(sourcesBaseDir, `sources_${catalogId}`);

  const [events, catalogRows] = await Promise.all([
    prisma.catalogEvent.findMany({
      where: { workflowGroupId: catalogId },
      select: {
        id: true,
        recordings: {
          select: {
            audioHash: true,
            isPrimary: true,
          },
        },
      },
      orderBy: { id: "asc" },
    }),
    prisma.catalogEntry.findMany({
      where: { workflowGroupId: catalogId },
      select: { audioHash: true },
    }),
  ]);

  const assignedHashes = new Set<string>();
  for (const event of events) {
    for (const recording of event.recordings) {
      assignedHashes.add(recording.audioHash);
    }
  }

  const catalogHashes = new Set(catalogRows.map((row) => row.audioHash));
  const unassignedHashes = Array.from(catalogHashes).filter(
    (hash) => !assignedHashes.has(hash)
  );

  const preserveLegacyHashes = new Set<string>();

  let eventsProcessed = 0;
  let eventsSkippedNoPrimary = 0;
  let eventsSkippedMultiplePrimary = 0;
  const skippedEventIds: number[] = [];
  let movedPosterVariants = 0;
  let movedSourceDirs = 0;
  let clearedEventPosterData = 0;
  let clearedEventSourceDirs = 0;

  for (const event of events) {
    const primaryRecordings = event.recordings.filter((recording) => recording.isPrimary);

    if (primaryRecordings.length !== 1) {
      skippedEventIds.push(event.id);
      if (primaryRecordings.length === 0) {
        eventsSkippedNoPrimary += 1;
      } else {
        eventsSkippedMultiplePrimary += 1;
      }

      for (const recording of event.recordings) {
        preserveLegacyHashes.add(recording.audioHash);
      }
      continue;
    }

    const primaryHash = primaryRecordings[0].audioHash;
    const migration = await migrateEventAssets(
      postersRoot,
      sourcesRoot,
      event.id,
      primaryHash,
      dryRun
    );

    eventsProcessed += 1;
    movedPosterVariants += migration.movedPosterVariants;
    movedSourceDirs += migration.movedSourceDir ? 1 : 0;
    clearedEventPosterData += migration.clearedEventPosterData ? 1 : 0;
    clearedEventSourceDirs += migration.clearedEventSourceDir ? 1 : 0;
  }

  const preservePosterPrefixes = new Set(
    Array.from(preserveLegacyHashes, (hash) => hash.slice(0, 8).toLowerCase())
  );

  const [deletedLegacySourceDirs, deletedLegacyPosterDirs] = await Promise.all([
    cleanupLegacySourceDirs(sourcesRoot, preserveLegacyHashes, dryRun),
    cleanupLegacyPosterDirs(postersRoot, preservePosterPrefixes, dryRun),
  ]);

  return {
    catalogId,
    eventsTotal: events.length,
    eventsProcessed,
    eventsSkippedNoPrimary,
    eventsSkippedMultiplePrimary,
    skippedEventIds,
    movedPosterVariants,
    movedSourceDirs,
    clearedEventPosterData,
    clearedEventSourceDirs,
    unassignedHashes: unassignedHashes.length,
    preservedLegacyHashes: preserveLegacyHashes.size,
    deletedLegacySourceDirs,
    deletedLegacyPosterDirs,
  };
}

function printSummary(summary: CatalogSummary): void {
  const skippedTotal = summary.eventsSkippedNoPrimary + summary.eventsSkippedMultiplePrimary;
  console.log(`[migrate-assets] ${summary.catalogId}`);
  console.log(`  events: total=${summary.eventsTotal} processed=${summary.eventsProcessed} skipped=${skippedTotal}`);
  if (skippedTotal > 0) {
    console.log(`  skipped-no-primary=${summary.eventsSkippedNoPrimary} skipped-multiple-primary=${summary.eventsSkippedMultiplePrimary}`);
    console.log(`  skipped-event-ids=${summary.skippedEventIds.join(",")}`);
  }
  console.log(`  moved-poster-variants=${summary.movedPosterVariants} moved-source-dirs=${summary.movedSourceDirs}`);
  console.log(`  cleared-event-poster-data=${summary.clearedEventPosterData} cleared-event-source-dirs=${summary.clearedEventSourceDirs}`);
  console.log(`  deleted-legacy-source-dirs=${summary.deletedLegacySourceDirs} deleted-legacy-poster-dirs=${summary.deletedLegacyPosterDirs}`);
  console.log(`  unassigned-hashes=${summary.unassignedHashes} preserved-legacy-hashes=${summary.preservedLegacyHashes}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun && !args.yes) {
    throw new Error("Destructive migration requires --yes (or use --dry-run)");
  }

  const mode = args.prod ? "production" : "development";
  const envFile = loadScriptEnv(mode);
  if (envFile) {
    console.log(`[migrate-assets] Loaded environment from ${envFile}`);
  }

  const connectionString = getDatabaseUrlOrThrow();
  console.log(`[migrate-assets] Database: ${redactDatabaseUrl(connectionString)}`);
  console.log(`[migrate-assets] mode=${mode} dryRun=${args.dryRun}`);

  const postersBaseDir = getPostersDir();
  const sourcesBaseDir = getSourcesDir();
  console.log(`[migrate-assets] postersDir=${postersBaseDir}`);
  console.log(`[migrate-assets] sourcesDir=${sourcesBaseDir}`);

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const catalogs = args.all
      ? await prisma.workflowGroup.findMany({
          where: { isActive: true },
          select: { id: true },
          orderBy: { id: "asc" },
        })
      : await prisma.workflowGroup.findMany({
          where: { id: args.catalogId ?? undefined },
          select: { id: true },
        });

    if (catalogs.length === 0) {
      throw new Error(args.catalogId ? `Catalog not found: ${args.catalogId}` : "No active catalogs found");
    }

    const summaries: CatalogSummary[] = [];

    for (const catalog of catalogs) {
      const summary = await processCatalog(
        prisma,
        postersBaseDir,
        sourcesBaseDir,
        catalog.id,
        args.dryRun
      );
      summaries.push(summary);
      printSummary(summary);
    }

    const totals = summaries.reduce(
      (acc, summary) => {
        acc.eventsTotal += summary.eventsTotal;
        acc.eventsProcessed += summary.eventsProcessed;
        acc.eventsSkippedNoPrimary += summary.eventsSkippedNoPrimary;
        acc.eventsSkippedMultiplePrimary += summary.eventsSkippedMultiplePrimary;
        acc.movedPosterVariants += summary.movedPosterVariants;
        acc.movedSourceDirs += summary.movedSourceDirs;
        acc.clearedEventPosterData += summary.clearedEventPosterData;
        acc.clearedEventSourceDirs += summary.clearedEventSourceDirs;
        acc.unassignedHashes += summary.unassignedHashes;
        acc.preservedLegacyHashes += summary.preservedLegacyHashes;
        acc.deletedLegacySourceDirs += summary.deletedLegacySourceDirs;
        acc.deletedLegacyPosterDirs += summary.deletedLegacyPosterDirs;
        return acc;
      },
      {
        eventsTotal: 0,
        eventsProcessed: 0,
        eventsSkippedNoPrimary: 0,
        eventsSkippedMultiplePrimary: 0,
        movedPosterVariants: 0,
        movedSourceDirs: 0,
        clearedEventPosterData: 0,
        clearedEventSourceDirs: 0,
        unassignedHashes: 0,
        preservedLegacyHashes: 0,
        deletedLegacySourceDirs: 0,
        deletedLegacyPosterDirs: 0,
      }
    );

    console.log("[migrate-assets] totals");
    console.log(`  events: total=${totals.eventsTotal} processed=${totals.eventsProcessed}`);
    console.log(`  skipped-no-primary=${totals.eventsSkippedNoPrimary} skipped-multiple-primary=${totals.eventsSkippedMultiplePrimary}`);
    console.log(`  moved-poster-variants=${totals.movedPosterVariants} moved-source-dirs=${totals.movedSourceDirs}`);
    console.log(`  cleared-event-poster-data=${totals.clearedEventPosterData} cleared-event-source-dirs=${totals.clearedEventSourceDirs}`);
    console.log(`  deleted-legacy-source-dirs=${totals.deletedLegacySourceDirs} deleted-legacy-poster-dirs=${totals.deletedLegacyPosterDirs}`);
    console.log(`  unassigned-hashes=${totals.unassignedHashes} preserved-legacy-hashes=${totals.preservedLegacyHashes}`);

    if (totals.eventsSkippedNoPrimary + totals.eventsSkippedMultiplePrimary > 0) {
      console.log("[migrate-assets] WARNING: some events were skipped due to invalid primary assignment; legacy recording asset dirs were preserved for those hashes.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[migrate-assets] FAILED", error);
  process.exit(1);
});
