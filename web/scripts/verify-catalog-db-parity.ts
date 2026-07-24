#!/usr/bin/env tsx
import fs from "fs/promises";
import Papa from "papaparse";
import prisma from "../src/lib/db";
import { rewritePath } from "../src/lib/security/path-validation";

type CsvRow = Record<string, string | undefined>;

interface CliArgs {
  groupId: string | null;
  includeInactive: boolean;
}

interface SetDiff {
  missing: string[];
  extra: string[];
}

interface MetadataPayload {
  [key: string]: string | undefined;
  filename?: string;
  sizeBytes?: string;
  sizeHuman?: string;
  fullPath?: string;
  scanRoot?: string;
  status?: string;
  duration?: string;
  album?: string;
  artist?: string;
  comment?: string;
  date?: string;
  encodedBy?: string;
  encoder?: string;
  genre?: string;
  title?: string;
  track?: string;
}

interface ArchivedPayload {
  [key: string]: string | undefined;
  originalPath?: string;
  compressedPath?: string;
  format?: string;
  bitrateKbps?: string;
  originalSizeBytes?: string;
  compressedSizeBytes?: string;
  compressionRatio?: string;
  duration?: string;
}

interface DuplicatePayload {
  [key: string]: string | undefined;
  hash?: string;
  originalPath?: string;
  duplicatePath?: string;
  scanRoot?: string;
  sizeBytes?: string;
  sizeHuman?: string;
  duration?: string;
  album?: string;
  artist?: string;
  comment?: string;
  date?: string;
  encodedBy?: string;
  encoder?: string;
  genre?: string;
  title?: string;
  track?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let groupId: string | null = null;
  let includeInactive = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--group" || arg === "-g") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --group");
      groupId = value;
      i += 1;
      continue;
    }
    if (arg === "--include-inactive") {
      includeInactive = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/verify-catalog-db-parity.ts [--group <YYYYMMDD_HHMMSS>] [--include-inactive]"
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { groupId, includeInactive };
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function getRowValue(row: CsvRow, candidates: string[]): string | undefined {
  const normalizedCandidates = new Set(candidates.map((c) => normalizeHeader(c)));
  for (const key of Object.keys(row)) {
    if (normalizedCandidates.has(normalizeHeader(key))) {
      return row[key];
    }
  }
  return undefined;
}

function normalizeHash(raw: string | undefined): string | null {
  const hash = raw?.trim();
  if (!hash) return null;
  return hash;
}

function compactPayload<T extends Record<string, string | undefined>>(payload: T): T {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

function toMetadataPayload(row: CsvRow): MetadataPayload {
  return compactPayload({
    filename: getRowValue(row, ["Filename"]),
    sizeBytes: getRowValue(row, ["Size (bytes)"]),
    sizeHuman: getRowValue(row, ["Size (human)"]),
    fullPath: getRowValue(row, ["Full Path"]),
    scanRoot: getRowValue(row, ["Scan Root"]),
    status: getRowValue(row, ["Status"]),
    duration: getRowValue(row, ["Duration"]),
    album: getRowValue(row, ["album"]),
    artist: getRowValue(row, ["artist"]),
    comment: getRowValue(row, ["comment"]),
    date: getRowValue(row, ["date"]),
    encodedBy: getRowValue(row, ["encoded_by"]),
    encoder: getRowValue(row, ["encoder"]),
    genre: getRowValue(row, ["genre"]),
    title: getRowValue(row, ["title"]),
    track: getRowValue(row, ["track"]),
  });
}

function toArchivedPayload(row: CsvRow): ArchivedPayload {
  return compactPayload({
    originalPath: getRowValue(row, ["Original Path"]),
    compressedPath: getRowValue(row, ["Compressed Path"]),
    format: getRowValue(row, ["Format"]),
    bitrateKbps: getRowValue(row, ["Bitrate (kbps)"]),
    originalSizeBytes: getRowValue(row, ["Original Size (bytes)"]),
    compressedSizeBytes: getRowValue(row, ["Compressed Size (bytes)"]),
    compressionRatio: getRowValue(row, ["Compression Ratio"]),
    duration: getRowValue(row, ["Duration"]),
  });
}

function toDuplicatePayload(row: CsvRow): DuplicatePayload {
  return compactPayload({
    hash: getRowValue(row, ["Hash"]),
    originalPath: getRowValue(row, ["Original Path"]),
    duplicatePath: getRowValue(row, ["Duplicate Path"]),
    scanRoot: getRowValue(row, ["Scan Root"]),
    sizeBytes: getRowValue(row, ["Size (bytes)"]),
    sizeHuman: getRowValue(row, ["Size (human)"]),
    duration: getRowValue(row, ["Duration"]),
    album: getRowValue(row, ["album"]),
    artist: getRowValue(row, ["artist"]),
    comment: getRowValue(row, ["comment"]),
    date: getRowValue(row, ["date"]),
    encodedBy: getRowValue(row, ["encoded_by"]),
    encoder: getRowValue(row, ["encoder"]),
    genre: getRowValue(row, ["genre"]),
    title: getRowValue(row, ["title"]),
    track: getRowValue(row, ["track"]),
  });
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCsvPath(filePath: string): Promise<string> {
  const rewritten = rewritePath(filePath);
  if (rewritten !== filePath && (await fileExists(rewritten))) {
    return rewritten;
  }
  if (await fileExists(filePath)) {
    return filePath;
  }
  if (rewritten !== filePath) {
    throw new Error(`CSV not readable: ${filePath} (mapped to ${rewritten})`);
  }
  throw new Error(`CSV not readable: ${filePath}`);
}

async function loadCsvRows(filePath: string): Promise<CsvRow[]> {
  const resolvedPath = await resolveCsvPath(filePath);
  const content = await fs.readFile(resolvedPath, "utf-8");
  return new Promise((resolve, reject) => {
    Papa.parse<CsvRow>(content, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length > 0) {
          console.warn("[verify-catalog-db-parity] CSV parse warnings:", results.errors.slice(0, 5));
        }
        resolve(results.data);
      },
      error: (error: Error) => reject(error),
    });
  });
}

function buildHashSet(rows: CsvRow[], candidates: string[]): Set<string> {
  const hashes = new Set<string>();
  for (const row of rows) {
    const hash = normalizeHash(getRowValue(row, candidates));
    if (hash) hashes.add(hash);
  }
  return hashes;
}

function ensureUniqueHashes(rows: CsvRow[], sourceName: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const hash = normalizeHash(getRowValue(row, ["Hash"]));
    if (!hash) continue;
    if (seen.has(hash)) {
      throw new Error(`Duplicate Hash in ${sourceName} CSV: ${hash}`);
    }
    seen.add(hash);
  }
}

function diffSets(expected: Set<string>, actual: Set<string>): SetDiff {
  const missing: string[] = [];
  const extra: string[] = [];

  for (const value of expected) {
    if (!actual.has(value)) missing.push(value);
  }
  for (const value of actual) {
    if (!expected.has(value)) extra.push(value);
  }

  missing.sort((a, b) => a.localeCompare(b));
  extra.sort((a, b) => a.localeCompare(b));
  return { missing, extra };
}

function sample(values: string[], max = 10): string[] {
  return values.slice(0, max);
}

async function verifyGroup(groupId: string): Promise<{ ok: boolean; mismatchCount: number }> {
  const group = await prisma.workflowGroup.findUnique({
    where: { id: groupId },
    include: {
      variants: {
        orderBy: { variant: "asc" },
      },
    },
  });
  if (!group) {
    throw new Error(`Workflow group not found: ${groupId}`);
  }

  const mismatches: string[] = [];

  const metadataRows = await loadCsvRows(group.metadataCatalogPath);
  const archivedRows = await loadCsvRows(group.archivedCatalogPath);
  const duplicateRows = group.duplicatesCatalogPath
    ? await loadCsvRows(group.duplicatesCatalogPath)
    : [];

  ensureUniqueHashes(metadataRows, "metadata");
  ensureUniqueHashes(archivedRows, "archived");

  const metadataHashes = buildHashSet(metadataRows, ["Hash"]);
  const archivedHashes = buildHashSet(archivedRows, ["Hash"]);
  const expectedUnion = new Set<string>([...metadataHashes, ...archivedHashes]);

  const metadataByHash = new Map<string, CsvRow>();
  for (const row of metadataRows) {
    const hash = normalizeHash(getRowValue(row, ["Hash"]));
    if (hash) {
      metadataByHash.set(hash, row);
    }
  }

  const archivedByHash = new Map<string, CsvRow>();
  for (const row of archivedRows) {
    const hash = normalizeHash(getRowValue(row, ["Hash"]));
    if (hash) {
      archivedByHash.set(hash, row);
    }
  }

  const expectedDuplicateCounts = new Map<string, number>();
  const expectedDuplicateKeys = new Set<string>();
  const expectedDuplicatePayloadByKey = new Map<string, DuplicatePayload>();
  for (const row of duplicateRows) {
    const hash = normalizeHash(getRowValue(row, ["Hash"]));
    const originalPath = getRowValue(row, ["Original Path"])?.trim();
    const duplicatePath = getRowValue(row, ["Duplicate Path"])?.trim();
    if (!hash || !originalPath || !duplicatePath) continue;
    expectedDuplicateCounts.set(hash, (expectedDuplicateCounts.get(hash) ?? 0) + 1);
    const key = `${hash}\u0000${originalPath}\u0000${duplicatePath}`;
    expectedDuplicateKeys.add(key);
    expectedDuplicatePayloadByKey.set(key, toDuplicatePayload(row));
  }

  const expectedListeningByVariant = new Map<string, Set<string>>();
  for (const variant of group.variants) {
    const variantSet = new Set<string>();
    if (variant.listeningArchivedCatalogPath) {
      const listeningRows = await loadCsvRows(variant.listeningArchivedCatalogPath);
      for (const row of listeningRows) {
        const hash = normalizeHash(getRowValue(row, ["sha256", "hash", "Hash"]));
        if (hash) variantSet.add(hash);
      }
    }
    expectedListeningByVariant.set(variant.variant, variantSet);
  }

  const [entryRows, dbDuplicateRows, dbListeningRows] = await Promise.all([
    prisma.catalogEntry.findMany({
      where: { workflowGroupId: groupId },
      select: {
        audioHash: true,
        hasArchived: true,
        hasMetadata: true,
        isActionable: true,
        duplicateCount: true,
        detailsPayloadVersion: true,
        sourceMetadataPayload: true,
        sourceArchivedPayload: true,
      },
    }),
    prisma.catalogDuplicate.findMany({
      where: { workflowGroupId: groupId },
      select: {
        audioHash: true,
        originalPath: true,
        duplicatePath: true,
        duplicatePayloadVersion: true,
        duplicatePayload: true,
      },
    }),
    prisma.catalogListeningEntry.findMany({
      where: { workflowGroupId: groupId },
      select: {
        variant: true,
        audioHash: true,
      },
    }),
  ]);

  const dbHashSet = new Set(entryRows.map((row) => row.audioHash));
  const hashDiff = diffSets(expectedUnion, dbHashSet);
  if (hashDiff.missing.length > 0 || hashDiff.extra.length > 0) {
    mismatches.push(
      `catalog_entry hash set mismatch: missing=${hashDiff.missing.length} extra=${hashDiff.extra.length}`
    );
    if (hashDiff.missing.length > 0) {
      mismatches.push(`  missing sample: ${sample(hashDiff.missing).join(", ")}`);
    }
    if (hashDiff.extra.length > 0) {
      mismatches.push(`  extra sample: ${sample(hashDiff.extra).join(", ")}`);
    }
  }

  const entryByHash = new Map(entryRows.map((row) => [row.audioHash, row]));
  for (const hash of expectedUnion) {
    const row = entryByHash.get(hash);
    if (!row) continue;

    const expectedHasMetadata = metadataHashes.has(hash);
    const expectedHasArchived = archivedHashes.has(hash);
    const expectedActionable = expectedHasMetadata && expectedHasArchived;
    const expectedDuplicateCount = expectedDuplicateCounts.get(hash) ?? 0;

    if (row.hasMetadata !== expectedHasMetadata) {
      mismatches.push(
        `catalog_entry.has_metadata mismatch for ${hash}: db=${row.hasMetadata} expected=${expectedHasMetadata}`
      );
    }
    if (row.hasArchived !== expectedHasArchived) {
      mismatches.push(
        `catalog_entry.has_archived mismatch for ${hash}: db=${row.hasArchived} expected=${expectedHasArchived}`
      );
    }
    if (row.isActionable !== expectedActionable) {
      mismatches.push(
        `catalog_entry.is_actionable mismatch for ${hash}: db=${row.isActionable} expected=${expectedActionable}`
      );
    }
    if (row.duplicateCount !== expectedDuplicateCount) {
      mismatches.push(
        `catalog_entry.duplicate_count mismatch for ${hash}: db=${row.duplicateCount} expected=${expectedDuplicateCount}`
      );
    }

    if (row.detailsPayloadVersion !== 1) {
      mismatches.push(
        `catalog_entry.details_payload_version mismatch for ${hash}: db=${row.detailsPayloadVersion} expected=1`
      );
    }

    const expectedMetadataPayload = metadataByHash.get(hash)
      ? toMetadataPayload(metadataByHash.get(hash)!)
      : null;
    const expectedArchivedPayload = archivedByHash.get(hash)
      ? toArchivedPayload(archivedByHash.get(hash)!)
      : null;

    const dbMetadataPayload = row.sourceMetadataPayload ?? null;
    const dbArchivedPayload = row.sourceArchivedPayload ?? null;

    if (stableStringify(dbMetadataPayload) !== stableStringify(expectedMetadataPayload)) {
      mismatches.push(`catalog_entry.source_metadata_payload mismatch for ${hash}`);
    }
    if (stableStringify(dbArchivedPayload) !== stableStringify(expectedArchivedPayload)) {
      mismatches.push(`catalog_entry.source_archived_payload mismatch for ${hash}`);
    }
  }

  const dbDuplicateKeys = new Set(
    dbDuplicateRows.map(
      (row) => `${row.audioHash}\u0000${row.originalPath}\u0000${row.duplicatePath}`
    )
  );
  const duplicateDiff = diffSets(expectedDuplicateKeys, dbDuplicateKeys);
  if (duplicateDiff.missing.length > 0 || duplicateDiff.extra.length > 0) {
    mismatches.push(
      `catalog_duplicate row set mismatch: missing=${duplicateDiff.missing.length} extra=${duplicateDiff.extra.length}`
    );
    if (duplicateDiff.missing.length > 0) {
      mismatches.push(`  duplicate missing sample: ${sample(duplicateDiff.missing).join(", ")}`);
    }
    if (duplicateDiff.extra.length > 0) {
      mismatches.push(`  duplicate extra sample: ${sample(duplicateDiff.extra).join(", ")}`);
    }
  }

  for (const row of dbDuplicateRows) {
    const key = `${row.audioHash}\u0000${row.originalPath}\u0000${row.duplicatePath}`;
    const expectedPayload = expectedDuplicatePayloadByKey.get(key);
    if (!expectedPayload) {
      continue;
    }
    if (row.duplicatePayloadVersion !== 1) {
      mismatches.push(
        `catalog_duplicate.duplicate_payload_version mismatch for ${key}: db=${row.duplicatePayloadVersion} expected=1`
      );
    }
    if (stableStringify(row.duplicatePayload ?? null) !== stableStringify(expectedPayload)) {
      mismatches.push(`catalog_duplicate.duplicate_payload mismatch for ${key}`);
    }
  }

  const dbListeningByVariant = new Map<string, Set<string>>();
  for (const row of dbListeningRows) {
    const set = dbListeningByVariant.get(row.variant) ?? new Set<string>();
    set.add(row.audioHash);
    dbListeningByVariant.set(row.variant, set);
  }

  const allVariants = new Set([
    ...expectedListeningByVariant.keys(),
    ...dbListeningByVariant.keys(),
  ]);
  for (const variant of allVariants) {
    const expectedSet = expectedListeningByVariant.get(variant) ?? new Set<string>();
    const actualSet = dbListeningByVariant.get(variant) ?? new Set<string>();
    const listeningDiff = diffSets(expectedSet, actualSet);
    if (listeningDiff.missing.length > 0 || listeningDiff.extra.length > 0) {
      mismatches.push(
        `catalog_listening_entry mismatch for variant=${variant}: missing=${listeningDiff.missing.length} extra=${listeningDiff.extra.length}`
      );
      if (listeningDiff.missing.length > 0) {
        mismatches.push(
          `  listening missing sample (${variant}): ${sample(listeningDiff.missing).join(", ")}`
        );
      }
      if (listeningDiff.extra.length > 0) {
        mismatches.push(
          `  listening extra sample (${variant}): ${sample(listeningDiff.extra).join(", ")}`
        );
      }
    }
  }

  // Explicit source availability parity check for each hash.
  // This mirrors expected API source availability: archived by archived membership,
  // listening by variant-specific listening catalog membership.
  for (const hash of expectedUnion) {
    const dbEntry = entryByHash.get(hash);
    if (!dbEntry) continue;

    const expectedArchivedAvailable = archivedHashes.has(hash);
    if (dbEntry.hasArchived !== expectedArchivedAvailable) {
      mismatches.push(
        `audio_source.archived availability mismatch for ${hash}: db=${dbEntry.hasArchived} expected=${expectedArchivedAvailable}`
      );
    }

    for (const variant of allVariants) {
      const expectedAvailable = expectedListeningByVariant.get(variant)?.has(hash) ?? false;
      const actualAvailable = dbListeningByVariant.get(variant)?.has(hash) ?? false;
      if (expectedAvailable !== actualAvailable) {
        mismatches.push(
          `audio_source.listening availability mismatch for ${hash} variant=${variant}: db=${actualAvailable} expected=${expectedAvailable}`
        );
      }
    }
  }

  if (mismatches.length > 0) {
    console.error(`\n[verify-catalog-db-parity] Group ${groupId}: FAILED`);
    for (const mismatch of mismatches.slice(0, 50)) {
      console.error(`[verify-catalog-db-parity] ${mismatch}`);
    }
    if (mismatches.length > 50) {
      console.error(
        `[verify-catalog-db-parity] ... ${mismatches.length - 50} additional mismatches omitted`
      );
    }
    return { ok: false, mismatchCount: mismatches.length };
  }

  console.log(
    `[verify-catalog-db-parity] Group ${groupId}: OK (hashes=${entryRows.length}, duplicates=${dbDuplicateRows.length}, listening=${dbListeningRows.length})`
  );
  return { ok: true, mismatchCount: 0 };
}

async function main() {
  const { groupId, includeInactive } = parseArgs(process.argv.slice(2));

  const groups = await prisma.workflowGroup.findMany({
    where: groupId
      ? { id: groupId }
      : includeInactive
        ? undefined
        : { isActive: true },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  if (groups.length === 0) {
    throw new Error("No workflow groups found for the requested scope");
  }

  console.log(
    `[verify-catalog-db-parity] Starting parity check for ${groups.length} group(s)`
  );

  let failedGroups = 0;
  let totalMismatches = 0;
  for (const group of groups) {
    const result = await verifyGroup(group.id);
    if (!result.ok) failedGroups += 1;
    totalMismatches += result.mismatchCount;
  }

  if (failedGroups > 0) {
    console.error(
      `[verify-catalog-db-parity] FAILED groups=${failedGroups} mismatches=${totalMismatches}`
    );
    process.exit(1);
  }

  console.log("[verify-catalog-db-parity] All groups passed");
}

main()
  .catch((error) => {
    console.error("[verify-catalog-db-parity] Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
