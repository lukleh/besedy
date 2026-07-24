import Papa from 'papaparse';
import prisma from '@/lib/db';
import fs from 'fs/promises';
import { readSourceSnapshot } from '@/lib/catalog-sync/source-snapshot';
import { rewritePath } from '@/lib/security/path-validation';

type CsvRow = Record<string, string | undefined>;

type SourceKind = 'metadata' | 'archived' | 'duplicates' | 'listening';

interface SourceDescriptor {
  kind: SourceKind;
  sourceKey: string;
  filePath: string | null;
  required: boolean;
  variant?: string;
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

export interface CatalogSyncResult {
  groupId: string;
  status: 'success' | 'skipped' | 'error';
  changedSources: string[];
  rowCounts: Record<string, number>;
  error?: string;
}

// A base-catalog sync that would drop the row count below this fraction of the
// previous count (or to zero) is refused unless explicitly allowed, so a
// truncated or empty source CSV can't silently wipe the database catalog.
const BASE_ROW_COUNT_DROP_RATIO = 0.5;

function isRowCountDropAllowedByEnv(): boolean {
  const raw =
    process.env.CATALOG_SYNC_ALLOW_ROW_COUNT_DROP?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

function shouldRunOrphanCleanup(result: CatalogSyncResult): boolean {
  if (result.status !== 'success') return false;
  const changed = new Set(result.changedSources);
  return changed.has('metadata') || changed.has('archived');
}

async function cleanupOrphanEventRecordings(groupId: string): Promise<number> {
  const deleted = await prisma.$executeRaw`
    DELETE FROM catalog_event_recording cer
    WHERE cer.workflow_group_id = ${groupId}
      AND NOT EXISTS (
        SELECT 1
        FROM catalog_entry ce
        WHERE ce.workflow_group_id = cer.workflow_group_id
          AND ce.audio_hash = cer.audio_hash
      )
  `;

  if (typeof deleted === 'number' && deleted > 0) {
    console.log(
      `[catalog-sync] Cleaned ${deleted} orphaned event-recording rows for ${groupId}`,
    );
  }

  return typeof deleted === 'number' ? deleted : 0;
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

function normalizeHash(raw: string | undefined): string | null {
  const hash = raw?.trim();
  if (!hash) return null;
  return hash;
}

async function parseCsvRows(content: string): Promise<CsvRow[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<CsvRow>(content, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length > 0) {
          console.warn('CSV parse warnings:', results.errors);
        }
        resolve(results.data);
      },
      error: (error: Error) => reject(error),
    });
  });
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

function toMetadataPayload(row: CsvRow): MetadataPayload {
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

function toArchivedPayload(row: CsvRow): ArchivedPayload {
  return {
    originalPath: getRowValue(row, ['Original Path']),
    compressedPath: getRowValue(row, ['Compressed Path']),
    format: getRowValue(row, ['Format']),
    bitrateKbps: getRowValue(row, ['Bitrate (kbps)']),
    originalSizeBytes: getRowValue(row, ['Original Size (bytes)']),
    compressedSizeBytes: getRowValue(row, ['Compressed Size (bytes)']),
    compressionRatio: getRowValue(row, ['Compression Ratio']),
    duration: getRowValue(row, ['Duration']),
  };
}

function toDuplicatePayload(row: CsvRow): DuplicatePayload {
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
  variants: Array<{
    variant: string;
    listeningArchivedCatalogPath: string | null;
  }>;
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
    ...group.variants.map((variant) => ({
      kind: 'listening' as const,
      sourceKey: `listening:${variant.variant}`,
      filePath: variant.listeningArchivedCatalogPath,
      required: false,
      variant: variant.variant,
    })),
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
        descriptor.required === other.required &&
        descriptor.variant === other.variant
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
      include: {
        variants: {
          orderBy: { variant: 'asc' },
        },
      },
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

    const result = await prisma.$transaction(
      async (tx) => {
        // Transaction-scoped lock guarantees lock acquire/release on the same session.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${getLockKey(groupId)}));`;

        const group = await tx.workflowGroup.findUnique({
          where: { id: groupId },
          include: {
            variants: {
              orderBy: { variant: 'asc' },
            },
          },
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
          },
        });

        if (!sourceStatesMatch(baselineStates, existingStates)) {
          throw new SourceSnapshotInvalidatedError(
            `Catalog sync state changed while sync was reading files: ${groupId}`,
          );
        }

        const runtimeStates = buildSourceRuntimeStates(
          existingStates,
          capturedSources,
          force,
        );
        const changedStates = runtimeStates.filter((state) => state.changed);

        if (changedStates.length === 0) {
          return {
            groupId,
            status: 'skipped' as const,
            changedSources: [],
            rowCounts,
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
        const listeningStates = runtimeStates.filter(
          (state) => state.descriptor.kind === 'listening',
        );

        const baseChanged = Boolean(
          metadataState?.changed || archivedState?.changed,
        );
        const duplicatesChanged = Boolean(duplicatesState?.changed);

        let metadataRows: CsvRow[] = [];
        let archivedRows: CsvRow[] = [];

        if (baseChanged) {
          metadataRows = await parseCsvRows(metadataState!.content!);
          archivedRows = await parseCsvRows(archivedState!.content!);

          rowCounts[metadataState!.descriptor.sourceKey] = countUniqueHashes(
            metadataRows,
            'metadata',
          );
          rowCounts[archivedState!.descriptor.sourceKey] = countUniqueHashes(
            archivedRows,
            'archived',
          );

          if (!allowRowCountDrop) {
            const previousRowCounts = new Map(
              existingStates.map((state) => [state.sourceKey, state.rowCount]),
            );
            for (const state of [metadataState!, archivedState!]) {
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
        }

        let duplicateRows: Array<{
          workflowGroupId: string;
          audioHash: string;
          originalPath: string;
          duplicatePath: string;
          duplicatePayload: DuplicatePayload;
          duplicatePayloadVersion: number;
        }> = [];

        if (duplicatesChanged) {
          if (duplicatesState?.resolvedFilePath) {
            const rows = await parseCsvRows(duplicatesState.content!);
            duplicateRows = rows
              .map((row) => {
                const audioHash = normalizeHash(getRowValue(row, ['Hash']));
                const originalPath = getRowValue(row, [
                  'Original Path',
                ])?.trim();
                const duplicatePath = getRowValue(row, [
                  'Duplicate Path',
                ])?.trim();
                if (!audioHash || !originalPath || !duplicatePath) {
                  return null;
                }
                return {
                  workflowGroupId: groupId,
                  audioHash,
                  originalPath,
                  duplicatePath,
                  duplicatePayload: toDuplicatePayload(row),
                  duplicatePayloadVersion: 1,
                };
              })
              .filter((row): row is NonNullable<typeof row> => row !== null);
          }

          rowCounts[duplicatesState!.descriptor.sourceKey] =
            duplicateRows.length;
        }

        const listeningRowsByVariant = new Map<
          string,
          Array<{
            workflowGroupId: string;
            variant: string;
            audioHash: string;
            compressedPath: string;
          }>
        >();

        for (const listeningState of listeningStates) {
          if (!listeningState.changed) continue;

          const variant = listeningState.descriptor.variant;
          if (!variant) continue;

          if (!listeningState.resolvedFilePath) {
            listeningRowsByVariant.set(variant, []);
            rowCounts[listeningState.descriptor.sourceKey] = 0;
            continue;
          }

          const rows = await parseCsvRows(listeningState.content!);
          const listeningRows = rows
            .map((row) => {
              const audioHash = normalizeHash(
                getRowValue(row, ['sha256', 'hash', 'Hash']),
              );
              const compressedPath = getRowValue(row, [
                'compressed path',
                'compressed_path',
                'path',
                'Compressed Path',
              ])?.trim();
              if (!audioHash || !compressedPath) return null;
              return {
                workflowGroupId: groupId,
                variant,
                audioHash,
                compressedPath,
              };
            })
            .filter((row): row is NonNullable<typeof row> => row !== null);

          listeningRowsByVariant.set(variant, listeningRows);
          rowCounts[listeningState.descriptor.sourceKey] = listeningRows.length;
        }

        let existingDuplicateCounts = new Map<string, number>();
        let existingPublicationByHash = new Map<string, boolean>();
        if (baseChanged && !duplicatesChanged) {
          const grouped = await tx.catalogDuplicate.groupBy({
            by: ['audioHash'],
            where: { workflowGroupId: groupId },
            _count: { _all: true },
          });
          existingDuplicateCounts = new Map(
            grouped.map((row) => [row.audioHash, row._count._all]),
          );
        }
        if (baseChanged) {
          const publicationRows = await tx.catalogEntry.findMany({
            where: { workflowGroupId: groupId },
            select: { audioHash: true, isPublished: true },
          });
          existingPublicationByHash = new Map(
            publicationRows.map((row) => [row.audioHash, row.isPublished]),
          );
        }

        const entryRows: Array<{
          workflowGroupId: string;
          audioHash: string;
          compressedPath: string | null;
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
          isPublished: boolean;
          duplicateCount: number;
        }> = [];

        if (baseChanged) {
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

          const duplicateCounts = duplicatesChanged
            ? buildDuplicateCounts(
                duplicateRows.map((row) => ({ audioHash: row.audioHash })),
              )
            : existingDuplicateCounts;

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
              isPublished: existingPublicationByHash.get(audioHash) ?? false,
              duplicateCount: duplicateCounts.get(audioHash) ?? 0,
            });
          }
        }

        const syncedAt = new Date();

        if (baseChanged) {
          await tx.catalogEntry.deleteMany({
            where: { workflowGroupId: groupId },
          });
          if (entryRows.length > 0) {
            await tx.catalogEntry.createMany({ data: entryRows });
          }
        }

        if (duplicatesChanged) {
          await tx.catalogDuplicate.deleteMany({
            where: { workflowGroupId: groupId },
          });
          if (duplicateRows.length > 0) {
            await tx.catalogDuplicate.createMany({ data: duplicateRows });
          }

          if (!baseChanged) {
            await tx.catalogEntry.updateMany({
              where: { workflowGroupId: groupId },
              data: { duplicateCount: 0 },
            });

            const duplicateCounts = buildDuplicateCounts(
              duplicateRows.map((row) => ({ audioHash: row.audioHash })),
            );

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
        }

        for (const listeningState of listeningStates) {
          if (!listeningState.changed || !listeningState.descriptor.variant)
            continue;

          const variant = listeningState.descriptor.variant;
          await tx.catalogListeningEntry.deleteMany({
            where: { workflowGroupId: groupId, variant },
          });

          const listeningRows = listeningRowsByVariant.get(variant) ?? [];
          if (listeningRows.length > 0) {
            await tx.catalogListeningEntry.createMany({ data: listeningRows });
          }
        }

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
              status: 'SUCCESS',
              lastError: null,
            },
          });
        }

        return {
          groupId,
          status: 'success' as const,
          changedSources,
          rowCounts,
        };
      },
      {
        maxWait: 10000,
        timeout: 120000,
      },
    );

    if (shouldRunOrphanCleanup(result)) {
      try {
        await cleanupOrphanEventRecordings(groupId);
      } catch (cleanupError) {
        console.error(
          `[catalog-sync] Orphan cleanup failed for ${groupId}:`,
          cleanupError,
        );
      }
    }

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

    const errorSourceKeys =
      changedSources.length > 0 ? changedSources : knownSourceKeys;

    if (errorSourceKeys.length > 0) {
      const syncedAt = new Date();
      for (const sourceKey of errorSourceKeys) {
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
  return syncCatalogGroupAttempt(groupId, options);
}

export async function syncActiveCatalogs(
  options: { force?: boolean; allowRowCountDrop?: boolean } = {},
): Promise<CatalogSyncResult[]> {
  const groups = await prisma.workflowGroup.findMany({
    where: { isActive: true },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const results: CatalogSyncResult[] = [];
  for (const group of groups) {
    const result = await syncCatalogGroup(group.id, options);
    results.push(result);
  }

  return results;
}
