import Papa from 'papaparse';
import { Prisma } from '@/generated/prisma/client';
import { replaceLostPrimaryRecording } from '@/lib/catalog-events/primary-succession';
import prisma from '@/lib/db';
import { assertArchiveCatalogId, requireArchive } from '@/lib/archive';
import fs from 'fs/promises';
import { syncCatalogEntries } from '@/lib/catalog-sync/entries';
import { readSourceSnapshot } from '@/lib/catalog-sync/source-snapshot';
import { rewritePath } from '@/lib/security/path-validation';
import { HashSchema } from '@/lib/validation/schemas';
import { CATALOG_CSV_VALIDATION } from '@/lib/catalog-sync/csv-contract';

type CsvRow = Record<string, string | undefined>;

type SourceKind = 'metadata' | 'archived' | 'duplicates';

interface SourceDescriptor {
  kind: SourceKind;
  sourceKey: string;
  filePath: string | null;
  required: boolean;
}

interface SourceRuntimeState {
  descriptor: SourceDescriptor;
  changed: boolean;
  fingerprint: string;
  resolvedFilePath: string | null;
  content: string | null;
}

type CapturedSource = Omit<SourceRuntimeState, 'changed'>;

interface ExistingSourceState {
  sourceKey: string;
  filePath: string;
  fingerprint: string;
  rowCount: number;
}

class SourceSnapshotInvalidatedError extends Error {}

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
  compressedAacPath?: string;
  format?: string;
  bitrateKbps?: string;
  originalSizeBytes?: string;
  compressedSizeBytes?: string;
  compressedAacSizeBytes?: string;
  compressedAacBitrateKbps?: string;
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

export interface CatalogSyncResult {
  groupId: string;
  status: 'success' | 'skipped' | 'error';
  changedSources: string[];
  rowCounts: Record<string, number>;
  /**
   * Metadata rows whose `Hash Algorithm` is missing or not the one this build
   * knows. They sync anyway; set only when there are some.
   */
  unrecognizedHashAlgorithmRows?: number;
  error?: string;
}

/** The decoded-audio hash contract the `Hash` column holds (see besedy/lib/catalog/manager.py). */
export const AUDIO_HASH_ALGORITHM = 'pcm-s16le-16000hz-mono-sha256-v1';

// A base-catalog sync that would drop the row count below this fraction of the
// previous count (or to zero) is refused unless explicitly allowed, so a
// truncated or empty source CSV can't silently wipe the database catalog.
const BASE_ROW_COUNT_DROP_RATIO = 0.5;

function isRowCountDropAllowedByEnv(): boolean {
  const raw =
    process.env.CATALOG_SYNC_ALLOW_ROW_COUNT_DROP?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

// Deletes event assignments whose recording left the catalog. An event that
// loses its primary recording this way gets its next playable recording as
// primary, or is unreleased when none is left (see replaceLostPrimaryRecording).
async function cleanupOrphanEventRecordings(groupId: string): Promise<void> {
  const summary = await prisma.$transaction(async (tx) => {
    const affected = await tx.$queryRaw<Array<{ eventId: number }>>`
      SELECT DISTINCT cer.event_id AS "eventId"
      FROM catalog_event_recording cer
      WHERE cer.workflow_group_id = ${groupId}
        AND NOT EXISTS (
          SELECT 1
          FROM catalog_entry ce
          WHERE ce.workflow_group_id = cer.workflow_group_id
            AND ce.audio_hash = cer.audio_hash
        )
    `;
    if (affected.length === 0) return null;

    const eventIds = affected.map((row) => row.eventId);
    // Serialize with release/detach operations on the affected event rows.
    await tx.$queryRaw`
      SELECT id
      FROM catalog_event
      WHERE id IN (${Prisma.join(eventIds)})
      ORDER BY id
      FOR UPDATE
    `;

    // Read the primary flags from the deleted rows, after the locks are held.
    const deleted = await tx.$queryRaw<
      Array<{ eventId: number; isPrimary: boolean }>
    >`
      DELETE FROM catalog_event_recording cer
      WHERE cer.workflow_group_id = ${groupId}
        AND cer.event_id IN (${Prisma.join(eventIds)})
        AND NOT EXISTS (
          SELECT 1
          FROM catalog_entry ce
          WHERE ce.workflow_group_id = cer.workflow_group_id
            AND ce.audio_hash = cer.audio_hash
        )
      RETURNING cer.event_id AS "eventId", cer.is_primary AS "isPrimary"
    `;

    const promoted: string[] = [];
    const unreleased: number[] = [];
    const lostPrimary = new Set(
      deleted.filter((row) => row.isPrimary).map((row) => row.eventId),
    );
    for (const eventId of lostPrimary) {
      const outcome = await replaceLostPrimaryRecording(tx, groupId, eventId);
      if (outcome.kind === 'promoted') {
        promoted.push(`${eventId} -> ${outcome.audioHash}`);
      }
      if (outcome.kind === 'unreleased') unreleased.push(eventId);
    }

    return { deleted: deleted.length, promoted, unreleased };
  });

  if (!summary || summary.deleted === 0) return;
  console.warn(
    `[catalog-sync] Deleted ${summary.deleted} event-recording rows for ${groupId} whose recording left the catalog`,
  );
  if (summary.promoted.length > 0) {
    console.warn(
      `[catalog-sync] Promoted a new primary recording in ${groupId} (event -> hash): ${summary.promoted.join(', ')}`,
    );
  }
  if (summary.unreleased.length > 0) {
    console.warn(
      `[catalog-sync] Unreleased events left without a playable recording in ${groupId}: ${summary.unreleased.join(', ')}`,
    );
  }
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function getRowValue(row: CsvRow, candidates: string[]): string | undefined {
  const normalizedCandidates = new Set(
    candidates.map((c) => normalizeHeader(c)),
  );
  for (const key of Object.keys(row)) {
    if (normalizedCandidates.has(normalizeHeader(key))) {
      return row[key];
    }
  }
  return undefined;
}

/** A path cell, or null when the column is missing or the cell is blank. */
function optionalPath(raw: string | undefined): string | null {
  return raw?.trim() || null;
}

function normalizeHash(raw: string | undefined): string | null {
  const hash = raw?.trim().toLowerCase();
  if (!hash) return null;
  return hash;
}

function parseCsvRows(content: string, kind: SourceKind): CsvRow[] {
  const results = Papa.parse<CsvRow>(content, {
    header: true,
    delimiter: ',',
    skipEmptyLines: true,
    transformHeader: normalizeHeader,
  });
  const invalid = (detail: string) => new Error(`Invalid ${kind} catalog CSV: ${detail}`);
  if (results.errors.length > 0) {
    const error = results.errors[0];
    throw invalid(`${error.code}: ${error.message}`);
  }

  // Papa renames duplicate headers before exposing fields; accepting the result
  // would silently pick one of two competing identity or payload columns.
  if (Object.keys(results.meta.renamedHeaders ?? {}).length > 0) {
    throw invalid('duplicate column names');
  }
  const fields = results.meta.fields ?? [];
  if (fields.includes('')) throw invalid('blank column name');
  const { requiredHeaders: required, nonBlankCells } = CATALOG_CSV_VALIDATION[kind];
  const missing = required.filter((column) => !fields.includes(normalizeHeader(column)));
  if (missing.length > 0) {
    throw invalid(`missing required columns: ${missing.join(', ')}`);
  }

  for (const [index, row] of results.data.entries()) {
    const hash = normalizeHash(getRowValue(row, ['Hash']));
    if (!HashSchema.safeParse(hash).success) {
      throw invalid(`data row ${index + 1} must have a 64-character hexadecimal Hash`);
    }
    for (const column of nonBlankCells) {
      if (!getRowValue(row, [column])?.trim()) {
        throw invalid(`data row ${index + 1} has a blank ${column}`);
      }
    }
  }
  return results.data;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSourceFilePath(filePath: string): Promise<string> {
  const rewritten = rewritePath(filePath);
  if (rewritten !== filePath && (await fileExists(rewritten))) {
    return rewritten;
  }
  if (await fileExists(filePath)) {
    return filePath;
  }
  if (rewritten !== filePath) {
    throw new Error(
      `Source not readable: ${filePath} (mapped to ${rewritten})`,
    );
  }
  throw new Error(`Source not readable: ${filePath}`);
}

function countUniqueHashes(rows: CsvRow[], sourceName: string): number {
  const seen = new Set<string>();
  for (const row of rows) {
    const hash = normalizeHash(getRowValue(row, ['Hash']));
    if (!hash) continue;
    if (seen.has(hash)) {
      throw new Error(`Duplicate Hash in ${sourceName} catalog: ${hash}`);
    }
    seen.add(hash);
  }
  return seen.size;
}

/** Rows with a hash whose `Hash Algorithm` is missing or not AUDIO_HASH_ALGORITHM. */
export function countUnrecognizedHashAlgorithms(rows: CsvRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (!normalizeHash(getRowValue(row, ['Hash']))) continue;
    if (getRowValue(row, ['Hash Algorithm'])?.trim() !== AUDIO_HASH_ALGORITHM) {
      count += 1;
    }
  }
  return count;
}

export function toMetadataPayload(row: CsvRow): MetadataPayload {
  return {
    filename: getRowValue(row, ['Filename']),
    sizeBytes: getRowValue(row, ['Size (bytes)']),
    sizeHuman: getRowValue(row, ['Size (human)']),
    fullPath: getRowValue(row, ['Full Path']),
    scanRoot: getRowValue(row, ['Scan Root']),
    status: getRowValue(row, ['Status']),
    duration: getRowValue(row, ['Duration']),
    album: getRowValue(row, ['album']),
    artist: getRowValue(row, ['artist']),
    comment: getRowValue(row, ['comment']),
    date: getRowValue(row, ['date']),
    encodedBy: getRowValue(row, ['encoded_by']),
    encoder: getRowValue(row, ['encoder']),
    genre: getRowValue(row, ['genre']),
    title: getRowValue(row, ['title']),
    track: getRowValue(row, ['track']),
  };
}

export function toArchivedPayload(row: CsvRow): ArchivedPayload {
  return {
    originalPath: getRowValue(row, ['Original Path']),
    compressedPath: getRowValue(row, ['Compressed Path']),
    compressedAacPath: getRowValue(row, ['Compressed AAC Path']),
    format: getRowValue(row, ['Format']),
    bitrateKbps: getRowValue(row, ['Bitrate (kbps)']),
    originalSizeBytes: getRowValue(row, ['Original Size (bytes)']),
    compressedSizeBytes: getRowValue(row, ['Compressed Size (bytes)']),
    compressedAacSizeBytes: getRowValue(row, ['Compressed AAC Size (bytes)']),
    compressedAacBitrateKbps: getRowValue(row, ['Compressed AAC Bitrate (kbps)']),
    compressionRatio: getRowValue(row, ['Compression Ratio']),
    duration: getRowValue(row, ['Duration']),
  };
}

export function toDuplicatePayload(row: CsvRow): DuplicatePayload {
  return {
    hash: getRowValue(row, ['Hash']),
    originalPath: getRowValue(row, ['Original Path']),
    duplicatePath: getRowValue(row, ['Duplicate Path']),
    scanRoot: getRowValue(row, ['Scan Root']),
    sizeBytes: getRowValue(row, ['Size (bytes)']),
    sizeHuman: getRowValue(row, ['Size (human)']),
    duration: getRowValue(row, ['Duration']),
    album: getRowValue(row, ['album']),
    artist: getRowValue(row, ['artist']),
    comment: getRowValue(row, ['comment']),
    date: getRowValue(row, ['date']),
    encodedBy: getRowValue(row, ['encoded_by']),
    encoder: getRowValue(row, ['encoder']),
    genre: getRowValue(row, ['genre']),
    title: getRowValue(row, ['title']),
    track: getRowValue(row, ['track']),
  };
}

function getLockKey(groupId: string): string {
  return `catalog_sync:${groupId}`;
}

function buildSourceDescriptors(group: {
  metadataCatalogPath: string;
  archivedCatalogPath: string;
  duplicatesCatalogPath: string | null;
}): SourceDescriptor[] {
  return [
    {
      kind: 'metadata',
      sourceKey: 'metadata',
      filePath: group.metadataCatalogPath,
      required: true,
    },
    {
      kind: 'archived',
      sourceKey: 'archived',
      filePath: group.archivedCatalogPath,
      required: true,
    },
    {
      kind: 'duplicates',
      sourceKey: 'duplicates',
      filePath: group.duplicatesCatalogPath,
      required: false,
    },
  ];
}

function descriptorsMatch(
  left: SourceDescriptor[],
  right: SourceDescriptor[],
): boolean {
  return (
    left.length === right.length &&
    left.every((descriptor, index) => {
      const other = right[index];
      return (
        descriptor.kind === other.kind &&
        descriptor.sourceKey === other.sourceKey &&
        descriptor.filePath === other.filePath &&
        descriptor.required === other.required
      );
    })
  );
}

async function captureSources(
  descriptors: SourceDescriptor[],
  existingStates: ExistingSourceState[],
  force: boolean,
): Promise<CapturedSource[]> {
  const stateBySourceKey = new Map(
    existingStates.map((state) => [state.sourceKey, state]),
  );
  const capturedSources: Array<
    CapturedSource & { changedAgainstBaseline: boolean }
  > = [];

  for (const descriptor of descriptors) {
    const existing = stateBySourceKey.get(descriptor.sourceKey);

    if (!descriptor.filePath) {
      if (descriptor.required) {
        throw new Error(
          `Missing required path for source ${descriptor.sourceKey}`,
        );
      }

      capturedSources.push({
        descriptor,
        changedAgainstBaseline:
          force ||
          !existing ||
          existing.filePath !== '' ||
          existing.fingerprint !== '<missing>',
        fingerprint: '<missing>',
        resolvedFilePath: null,
        content: null,
      });
      continue;
    }

    let resolvedFilePath: string;
    try {
      resolvedFilePath = await resolveSourceFilePath(descriptor.filePath);
    } catch (error) {
      if (descriptor.required) {
        throw new Error(`Required source not readable: ${descriptor.filePath}`);
      }
      throw error;
    }

    const snapshot = await readSourceSnapshot(resolvedFilePath);
    const changedAgainstBaseline =
      force ||
      !existing ||
      existing.filePath !== descriptor.filePath ||
      existing.fingerprint !== snapshot.fingerprint;
    capturedSources.push({
      descriptor,
      changedAgainstBaseline,
      fingerprint: snapshot.fingerprint,
      resolvedFilePath,
      // A base rebuild needs both sides of the metadata/archive join. Optional
      // sources can release unchanged content immediately after hashing.
      content:
        changedAgainstBaseline ||
        descriptor.kind === 'metadata' ||
        descriptor.kind === 'archived'
          ? snapshot.content
          : null,
    });
  }

  const baseChanged = capturedSources.some(
    (source) =>
      (source.descriptor.kind === 'metadata' ||
        source.descriptor.kind === 'archived') &&
      source.changedAgainstBaseline,
  );

  return capturedSources.map((source) => ({
    descriptor: source.descriptor,
    fingerprint: source.fingerprint,
    resolvedFilePath: source.resolvedFilePath,
    content:
      !baseChanged &&
      (source.descriptor.kind === 'metadata' ||
        source.descriptor.kind === 'archived')
        ? null
        : source.content,
  }));
}

function sourceStatesMatch(
  left: ExistingSourceState[],
  right: ExistingSourceState[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByKey = new Map(right.map((state) => [state.sourceKey, state]));
  return left.every((state) => {
    const other = rightByKey.get(state.sourceKey);
    return (
      other?.filePath === state.filePath &&
      other.fingerprint === state.fingerprint &&
      other.rowCount === state.rowCount
    );
  });
}

function buildSourceRuntimeStates(
  existingStates: Array<{
    sourceKey: string;
    filePath: string;
    fingerprint: string;
  }>,
  capturedSources: CapturedSource[],
  force: boolean,
): SourceRuntimeState[] {
  const stateBySourceKey = new Map(
    existingStates.map((state) => [state.sourceKey, state]),
  );

  return capturedSources.map((captured) => {
    const { descriptor } = captured;
    const existing = stateBySourceKey.get(descriptor.sourceKey);
    const changed =
      force ||
      !existing ||
      existing.filePath !== (descriptor.filePath ?? '') ||
      existing.fingerprint !== captured.fingerprint;

    return {
      ...captured,
      changed,
    };
  });
}

function buildDuplicateCounts(
  rows: Array<{ audioHash: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.audioHash, (counts.get(row.audioHash) ?? 0) + 1);
  }
  return counts;
}

interface ExistingSyncState extends ExistingSourceState {
  status: string;
  syncedAt: Date;
}

interface UnchangedSourceError {
  sourceKey: string;
  filePath: string;
  fingerprint: string;
  syncedAt: Date;
  status: 'ERROR';
}

interface SourceClassification {
  runtimeStates: SourceRuntimeState[];
  changedStates: SourceRuntimeState[];
  unchangedSourceErrors: UnchangedSourceError[];
}

interface ParsedBaseSources {
  metadataRows: CsvRow[];
  archivedRows: CsvRow[];
  unrecognizedHashAlgorithmRows: number;
}

interface DuplicateRow {
  workflowGroupId: string;
  audioHash: string;
  originalPath: string;
  duplicatePath: string;
  duplicatePayload: DuplicatePayload;
  duplicatePayloadVersion: number;
}

interface EntryRow {
  workflowGroupId: string;
  audioHash: string;
  compressedPath: string | null;
  compressedAacPath: string | null;
  originalPath: string | null;
  filename: string | null;
  scanRoot: string | null;
  durationHms: string | null;
  sourceTitle: string | null;
  sourceArtist: string | null;
  sourceAlbum: string | null;
  sourceDate: string | null;
  sourceMetadataPayload?: MetadataPayload;
  sourceArchivedPayload?: ArchivedPayload;
  detailsPayloadVersion: number;
  hasArchived: boolean;
  hasMetadata: boolean;
  isActionable: boolean;
  duplicateCount: number;
}

interface SyncAttemptContext {
  groupId: string;
  force: boolean;
  allowRowCountDrop: boolean;
  sourceDescriptors: SourceDescriptor[];
  baselineStates: ExistingSourceState[];
  capturedSources: CapturedSource[];
  // Filled in while the transaction runs so that a failure part-way through
  // still reports which sources were being written and what was counted.
  rowCounts: Record<string, number>;
  changedSources: string[];
}

interface SyncTransactionOutcome {
  result: CatalogSyncResult;
  // Unchanged sources whose last attempt failed. Cleared only after orphan
  // reconciliation succeeded, so the dependency is explicit to the caller.
  unchangedSourceErrors: UnchangedSourceError[];
}

async function lockAndRevalidateSnapshot(
  tx: Prisma.TransactionClient,
  groupId: string,
  sourceDescriptors: SourceDescriptor[],
  baselineStates: ExistingSourceState[],
): Promise<ExistingSyncState[]> {
  // Transaction-scoped lock guarantees lock acquire/release on the same session.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${getLockKey(groupId)}));`;

  const group = await tx.workflowGroup.findUnique({
    where: { id: groupId },
  });

  if (!group) {
    throw new Error(`Workflow group not found: ${groupId}`);
  }

  const currentDescriptors = buildSourceDescriptors(group);
  if (!descriptorsMatch(sourceDescriptors, currentDescriptors)) {
    throw new SourceSnapshotInvalidatedError(
      `Workflow group sources changed while sync was reading files: ${groupId}`,
    );
  }

  const existingStates = await tx.catalogSyncState.findMany({
    where: { workflowGroupId: groupId },
    select: {
      sourceKey: true,
      filePath: true,
      fingerprint: true,
      rowCount: true,
      status: true,
      syncedAt: true,
    },
  });

  if (!sourceStatesMatch(baselineStates, existingStates)) {
    throw new SourceSnapshotInvalidatedError(
      `Catalog sync state changed while sync was reading files: ${groupId}`,
    );
  }

  return existingStates;
}

function classifySources(
  existingStates: ExistingSyncState[],
  capturedSources: CapturedSource[],
  force: boolean,
): SourceClassification {
  const runtimeStates = buildSourceRuntimeStates(
    existingStates,
    capturedSources,
    force,
  );
  const changedStates = runtimeStates.filter((state) => state.changed);

  // A failed attempt kept the last good fingerprint. Restoring those
  // exact bytes needs no projection rebuild, but should clear its error
  // once the rest of reconciliation has succeeded.
  const unchangedSourceErrors: UnchangedSourceError[] = [];
  for (const state of runtimeStates.filter((source) => !source.changed)) {
    const previous = existingStates.find((source) => source.sourceKey === state.descriptor.sourceKey);
    if (previous?.status === 'ERROR') {
      unchangedSourceErrors.push({
        sourceKey: previous.sourceKey,
        filePath: previous.filePath,
        fingerprint: previous.fingerprint,
        syncedAt: previous.syncedAt,
        status: 'ERROR',
      });
    }
  }

  return { runtimeStates, changedStates, unchangedSourceErrors };
}

function parseBaseSources(
  groupId: string,
  metadataState: SourceRuntimeState,
  archivedState: SourceRuntimeState,
  rowCounts: Record<string, number>,
): ParsedBaseSources {
  const metadataRows = parseCsvRows(metadataState.content!, 'metadata');
  const archivedRows = parseCsvRows(archivedState.content!, 'archived');

  const unrecognizedHashAlgorithmRows =
    countUnrecognizedHashAlgorithms(metadataRows);
  if (unrecognizedHashAlgorithmRows > 0) {
    console.warn(
      `[catalog-sync] ${groupId}: ${unrecognizedHashAlgorithmRows} metadata rows have a missing or unknown Hash Algorithm (expected ${AUDIO_HASH_ALGORITHM}); syncing them anyway`,
    );
  }

  rowCounts[metadataState.descriptor.sourceKey] = countUniqueHashes(
    metadataRows,
    'metadata',
  );
  rowCounts[archivedState.descriptor.sourceKey] = countUniqueHashes(
    archivedRows,
    'archived',
  );

  return { metadataRows, archivedRows, unrecognizedHashAlgorithmRows };
}

async function assertBaseRowCountsNotDropped(
  tx: Prisma.TransactionClient,
  groupId: string,
  baseStates: SourceRuntimeState[],
  existingStates: ExistingSourceState[],
  rowCounts: Record<string, number>,
): Promise<void> {
  const previousRowCounts = new Map(
    existingStates.map((state) => [state.sourceKey, state.rowCount]),
  );
  for (const state of baseStates) {
    const sourceKey = state.descriptor.sourceKey;
    const liveRowCount = await tx.catalogEntry.count({
      where: {
        workflowGroupId: groupId,
        ...(state.descriptor.kind === 'metadata'
          ? { hasMetadata: true }
          : { hasArchived: true }),
      },
    });
    const previous = Math.max(
      previousRowCounts.get(sourceKey) ?? 0,
      liveRowCount,
    );
    const next = rowCounts[sourceKey] ?? 0;
    // Only a drop from a populated baseline is suspicious; syncing an
    // empty catalog into an empty/new one loses nothing.
    if (previous > 0 && next === 0) {
      throw new Error(
        `Refusing to sync ${sourceKey} for ${groupId}: source CSV is empty ` +
          `while ${previous} rows exist; rerun with allowRowCountDrop or set ` +
          `CATALOG_SYNC_ALLOW_ROW_COUNT_DROP=true to override`,
      );
    }
    if (previous > 0 && next < previous * BASE_ROW_COUNT_DROP_RATIO) {
      throw new Error(
        `Refusing to sync ${sourceKey} for ${groupId}: row count dropped from ${previous} to ${next}; ` +
          `rerun with allowRowCountDrop or set CATALOG_SYNC_ALLOW_ROW_COUNT_DROP=true to override`,
      );
    }
  }
}

function buildDuplicateRows(groupId: string, rows: CsvRow[]): DuplicateRow[] {
  return rows.flatMap((row) => {
    const originalPath = optionalPath(getRowValue(row, ['Original Path']));
    if (!originalPath) return [];
    return [{
      workflowGroupId: groupId,
      audioHash: normalizeHash(getRowValue(row, ['Hash']))!,
      originalPath,
      duplicatePath: getRowValue(row, ['Duplicate Path'])!.trim(),
      duplicatePayload: toDuplicatePayload(row),
      duplicatePayloadVersion: 1,
    }];
  });
}

async function loadExistingDuplicateCounts(
  tx: Prisma.TransactionClient,
  groupId: string,
): Promise<Map<string, number>> {
  const grouped = await tx.catalogDuplicate.groupBy({
    by: ['audioHash'],
    where: { workflowGroupId: groupId },
    _count: { _all: true },
  });
  return new Map(grouped.map((row) => [row.audioHash, row._count._all]));
}

function buildEntryRows(
  groupId: string,
  metadataRows: CsvRow[],
  archivedRows: CsvRow[],
  duplicateCounts: Map<string, number>,
): EntryRow[] {
  const metadataByHash = new Map<string, CsvRow>();
  for (const row of metadataRows) {
    const hash = normalizeHash(getRowValue(row, ['Hash']));
    if (hash) metadataByHash.set(hash, row);
  }

  const archivedByHash = new Map<string, CsvRow>();
  for (const row of archivedRows) {
    const hash = normalizeHash(getRowValue(row, ['Hash']));
    if (hash) archivedByHash.set(hash, row);
  }

  const allHashes = new Set([
    ...metadataByHash.keys(),
    ...archivedByHash.keys(),
  ]);

  const entryRows: EntryRow[] = [];
  for (const audioHash of allHashes) {
    const metadata = metadataByHash.get(audioHash);
    const archived = archivedByHash.get(audioHash);

    const metadataPayload = metadata
      ? toMetadataPayload(metadata)
      : null;
    const archivedPayload = archived
      ? toArchivedPayload(archived)
      : null;

    const originalPath =
      metadataPayload?.fullPath ??
      getRowValue(metadata ?? {}, ['Original Path']) ??
      archivedPayload?.originalPath ??
      null;

    const durationHms =
      metadataPayload?.duration ?? archivedPayload?.duration ?? null;

    entryRows.push({
      workflowGroupId: groupId,
      audioHash,
      compressedPath: archivedPayload?.compressedPath ?? null,
      compressedAacPath: optionalPath(archivedPayload?.compressedAacPath),
      originalPath,
      filename: metadataPayload?.filename ?? null,
      scanRoot: metadataPayload?.scanRoot ?? null,
      durationHms,
      sourceTitle: metadataPayload?.title ?? null,
      sourceArtist: metadataPayload?.artist ?? null,
      sourceAlbum: metadataPayload?.album ?? null,
      sourceDate: metadataPayload?.date ?? null,
      sourceMetadataPayload: metadataPayload ?? undefined,
      sourceArchivedPayload: archivedPayload ?? undefined,
      detailsPayloadVersion: 1,
      hasArchived: !!archived,
      hasMetadata: !!metadata,
      isActionable: !!archived && !!metadata,
      duplicateCount: duplicateCounts.get(audioHash) ?? 0,
    });
  }
  return entryRows;
}

async function replaceDuplicates(
  tx: Prisma.TransactionClient,
  groupId: string,
  duplicateRows: DuplicateRow[],
): Promise<void> {
  await tx.catalogDuplicate.deleteMany({
    where: { workflowGroupId: groupId },
  });
  if (duplicateRows.length > 0) {
    await tx.catalogDuplicate.createMany({ data: duplicateRows });
  }
}

async function refreshEntryDuplicateCounts(
  tx: Prisma.TransactionClient,
  groupId: string,
  duplicateRows: DuplicateRow[],
): Promise<void> {
  await tx.catalogEntry.updateMany({
    where: { workflowGroupId: groupId },
    data: { duplicateCount: 0 },
  });

  const duplicateCounts = buildDuplicateCounts(duplicateRows);

  for (const [
    audioHash,
    duplicateCount,
  ] of duplicateCounts.entries()) {
    await tx.catalogEntry.updateMany({
      where: { workflowGroupId: groupId, audioHash },
      data: { duplicateCount },
    });
  }
}

async function recordSourceSuccess(
  tx: Prisma.TransactionClient,
  groupId: string,
  changedStates: SourceRuntimeState[],
  rowCounts: Record<string, number>,
  syncedAt: Date,
): Promise<void> {
  for (const state of changedStates) {
    const sourceKey = state.descriptor.sourceKey;
    const filePath = state.descriptor.filePath ?? '';
    const fingerprint = state.fingerprint;
    const rowCount = rowCounts[sourceKey] ?? 0;

    await tx.catalogSyncState.upsert({
      where: {
        workflowGroupId_sourceKey: {
          workflowGroupId: groupId,
          sourceKey,
        },
      },
      update: {
        filePath,
        fingerprint,
        rowCount,
        syncedAt,
        lastSuccessfulAt: syncedAt,
        status: 'SUCCESS',
        lastError: null,
      },
      create: {
        workflowGroupId: groupId,
        sourceKey,
        filePath,
        fingerprint,
        rowCount,
        syncedAt,
        lastSuccessfulAt: syncedAt,
        status: 'SUCCESS',
        lastError: null,
      },
    });
  }
}

// Everything a source's commit depends on happens here under the advisory
// lock: projection writes, fingerprints and the SUCCESS state for a source
// land in the same transaction.
async function runSyncTransaction(
  tx: Prisma.TransactionClient,
  context: SyncAttemptContext,
): Promise<SyncTransactionOutcome> {
  const {
    groupId,
    force,
    allowRowCountDrop,
    sourceDescriptors,
    baselineStates,
    capturedSources,
    rowCounts,
    changedSources,
  } = context;

  const existingStates = await lockAndRevalidateSnapshot(
    tx,
    groupId,
    sourceDescriptors,
    baselineStates,
  );

  const { runtimeStates, changedStates, unchangedSourceErrors } =
    classifySources(existingStates, capturedSources, force);

  if (changedStates.length === 0) {
    return {
      result: {
        groupId,
        status: 'skipped' as const,
        changedSources: [],
        rowCounts,
      },
      unchangedSourceErrors,
    };
  }

  changedSources.push(
    ...changedStates.map((state) => state.descriptor.sourceKey),
  );

  const metadataState = runtimeStates.find(
    (state) => state.descriptor.kind === 'metadata',
  );
  const archivedState = runtimeStates.find(
    (state) => state.descriptor.kind === 'archived',
  );
  const duplicatesState = runtimeStates.find(
    (state) => state.descriptor.kind === 'duplicates',
  );

  const baseChanged = Boolean(
    metadataState?.changed || archivedState?.changed,
  );
  const duplicatesChanged = Boolean(duplicatesState?.changed);

  let base: ParsedBaseSources = {
    metadataRows: [],
    archivedRows: [],
    unrecognizedHashAlgorithmRows: 0,
  };
  if (baseChanged) {
    base = parseBaseSources(groupId, metadataState!, archivedState!, rowCounts);
    if (!allowRowCountDrop) {
      await assertBaseRowCountsNotDropped(
        tx,
        groupId,
        [metadataState!, archivedState!],
        existingStates,
        rowCounts,
      );
    }
  }

  let duplicateRows: DuplicateRow[] = [];
  if (duplicatesChanged) {
    if (duplicatesState?.resolvedFilePath) {
      duplicateRows = buildDuplicateRows(
        groupId,
        parseCsvRows(duplicatesState.content!, 'duplicates'),
      );
    }

    rowCounts[duplicatesState!.descriptor.sourceKey] = duplicateRows.length;
  }

  let entryRows: EntryRow[] = [];
  if (baseChanged) {
    const duplicateCounts = duplicatesChanged
      ? buildDuplicateCounts(duplicateRows)
      : await loadExistingDuplicateCounts(tx, groupId);
    entryRows = buildEntryRows(
      groupId,
      base.metadataRows,
      base.archivedRows,
      duplicateCounts,
    );
  }

  const syncedAt = new Date();

  if (baseChanged) {
    await syncCatalogEntries(tx, groupId, entryRows, syncedAt);
  }

  if (duplicatesChanged) {
    await replaceDuplicates(tx, groupId, duplicateRows);
    if (!baseChanged) {
      await refreshEntryDuplicateCounts(tx, groupId, duplicateRows);
    }
  }

  await recordSourceSuccess(tx, groupId, changedStates, rowCounts, syncedAt);

  return {
    result: {
      groupId,
      status: 'success' as const,
      changedSources,
      rowCounts,
      ...(base.unrecognizedHashAlgorithmRows > 0 && {
        unrecognizedHashAlgorithmRows: base.unrecognizedHashAlgorithmRows,
      }),
    },
    unchangedSourceErrors,
  };
}

async function clearRecoveredSourceErrors(
  groupId: string,
  unchangedSourceErrors: UnchangedSourceError[],
): Promise<void> {
  if (unchangedSourceErrors.length === 0) return;
  await prisma.catalogSyncState.updateMany({
    // Do not clear a newer failure recorded while cleanup was running.
    where: { workflowGroupId: groupId, OR: unchangedSourceErrors },
    data: { status: 'SUCCESS', lastError: null, syncedAt: new Date() },
  });
}

async function recordSourceErrors(
  groupId: string,
  sourceKeys: string[],
  message: string,
): Promise<void> {
  if (sourceKeys.length === 0) return;
  const syncedAt = new Date();
  for (const sourceKey of sourceKeys) {
    await prisma.catalogSyncState.upsert({
      where: {
        workflowGroupId_sourceKey: {
          workflowGroupId: groupId,
          sourceKey,
        },
      },
      update: {
        status: 'ERROR',
        syncedAt,
        lastError: message,
      },
      create: {
        workflowGroupId: groupId,
        sourceKey,
        filePath: '',
        fingerprint: '<error>',
        rowCount: 0,
        syncedAt,
        status: 'ERROR',
        lastError: message,
      },
    });
  }
}

async function syncCatalogGroupAttempt(
  groupId: string,
  options: { force?: boolean; allowRowCountDrop?: boolean } = {},
  retryInvalidatedSnapshot = true,
): Promise<CatalogSyncResult> {
  const force = options.force === true;
  const allowRowCountDrop =
    options.allowRowCountDrop === true || isRowCountDropAllowedByEnv();

  const rowCounts: Record<string, number> = {};
  const changedSources: string[] = [];
  let knownSourceKeys: string[] = [];

  try {
    // File reads and content hashing are intentionally outside the transaction
    // and advisory lock. The transaction consumes this immutable byte snapshot,
    // so its fingerprint always identifies exactly the content that is parsed.
    const sourceGroup = await prisma.workflowGroup.findUnique({
      where: { id: groupId },
    });

    if (!sourceGroup) {
      throw new Error(`Workflow group not found: ${groupId}`);
    }

    const sourceDescriptors = buildSourceDescriptors(sourceGroup);
    knownSourceKeys = sourceDescriptors.map(
      (descriptor) => descriptor.sourceKey,
    );
    const baselineStates = await prisma.catalogSyncState.findMany({
      where: { workflowGroupId: groupId },
      select: {
        sourceKey: true,
        filePath: true,
        fingerprint: true,
        rowCount: true,
      },
    });
    const capturedSources = await captureSources(
      sourceDescriptors,
      baselineStates,
      force,
    );

    const { result, unchangedSourceErrors } = await prisma.$transaction(
      (tx) =>
        runSyncTransaction(tx, {
          groupId,
          force,
          allowRowCountDrop,
          sourceDescriptors,
          baselineStates,
          capturedSources,
          rowCounts,
          changedSources,
        }),
      {
        maxWait: 10000,
        timeout: 120000,
      },
    );

    // Fingerprints are already committed. Reconcile even when the source bytes
    // were unchanged so a failed cleanup (or a crash before it) is retried.
    try {
      await cleanupOrphanEventRecordings(groupId);
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const error = `Orphan cleanup failed for ${groupId}: ${detail}`;
      console.error(`[catalog-sync] ${error}`, cleanupError);
      return { ...result, status: 'error', error };
    }

    await clearRecoveredSourceErrors(groupId, unchangedSourceErrors);
    return result;
  } catch (error) {
    if (error instanceof SourceSnapshotInvalidatedError) {
      if (retryInvalidatedSnapshot) {
        return syncCatalogGroupAttempt(groupId, options, false);
      }

      // This is a coordination conflict, not a bad source. Preserve the state
      // written by the concurrent sync instead of overwriting it with ERROR.
      return {
        groupId,
        status: 'error',
        changedSources: [],
        rowCounts: {},
        error: error.message,
      };
    }

    const message = error instanceof Error ? error.message : String(error);

    await recordSourceErrors(
      groupId,
      changedSources.length > 0 ? changedSources : knownSourceKeys,
      message,
    );

    return {
      groupId,
      status: 'error',
      changedSources,
      rowCounts,
      error: message,
    };
  }
}

export async function syncCatalogGroup(
  groupId: string,
  options: { force?: boolean; allowRowCountDrop?: boolean } = {},
): Promise<CatalogSyncResult> {
  await assertArchiveCatalogId(groupId);
  return syncCatalogGroupAttempt(groupId, options);
}

export async function syncActiveCatalogs(
  options: { force?: boolean; allowRowCountDrop?: boolean } = {},
): Promise<CatalogSyncResult[]> {
  const archive = await requireArchive();
  return [await syncCatalogGroup(archive.id, options)];
}
