'use client';

/**
 * Local content source.
 *
 * Answers the same questions the API answers for an event page, but from a
 * completed download package. The normal pages call the network first and
 * fall back here only when the request itself could not be made, so an online
 * page is always current and an offline page renders through the same
 * components. See docs/web/offline.md, "The online/offline content seam".
 *
 * Capabilities are derived from what the package holds, never copied from a
 * stale online answer: nothing can be edited, re-downloaded or searched
 * offline, and a transcript exists only when it was stored.
 */
import { ApiError } from '@/lib/api/fetch-json';
import type {
  AvailableDiarizations,
  AvailableFormats,
  AvailableTranscripts,
  Diarization,
  Transcript,
} from '@/components/transcript/transcript-viewer-types';
import type {
  CatalogEntryResponse,
  CatalogEntryWithPermissions,
} from '@/types/catalog';
import type { EventDetailResponse } from '@/types/event-detail';
import { downloadManager } from './download-manager';
import {
  getDownloadBundle,
  makeDownloadKey,
  makeEventKey,
  type DownloadBundlePayload,
  type DownloadRecord,
} from './downloads-db';

/**
 * A request that never reached the server: offline, DNS, or a dropped
 * connection. Server verdicts (any HTTP status, schema mismatches) are not
 * network failures and must keep their meaning.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof ApiError) return false;
  return error instanceof TypeError;
}

/**
 * Run `request`; if it fails because the network is unreachable and `local`
 * can answer from a complete package, return that answer instead. Every other
 * error propagates unchanged.
 */
export async function withLocalFallback<T>(
  request: () => Promise<T>,
  local: () => Promise<T | null>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    const fallback = await local().catch(() => null);
    if (fallback !== null) return fallback;
    throw error;
  }
}

async function completeRecords(): Promise<DownloadRecord[]> {
  await downloadManager.hydrate();
  return downloadManager
    .getSnapshot()
    .records.filter((record) => record.status === 'complete');
}

export async function findLocalRecording(
  catalogId: string,
  hash: string,
): Promise<DownloadRecord | null> {
  const key = makeDownloadKey(catalogId, hash);
  const records = await completeRecords();
  return records.find((record) => record.key === key) ?? null;
}

export async function findLocalEvent(
  catalogId: string,
  eventId: number,
): Promise<DownloadRecord | null> {
  const eventKey = makeEventKey(catalogId, eventId);
  const records = await completeRecords();
  return (
    records.find((record) => record.eventKey === eventKey) ??
    // Records written before event keys were stored only carry the snapshot.
    records.find(
      (record) => record.catalogId === catalogId && record.event?.id === eventId,
    ) ??
    null
  );
}

async function readPackage(
  record: DownloadRecord,
): Promise<{ record: DownloadRecord; bundle: DownloadBundlePayload | null }> {
  let bundle: DownloadBundlePayload | null = null;
  try {
    bundle = (await getDownloadBundle(record.key)) ?? null;
  } catch {
    // The registry row alone still describes a playable recording.
  }
  return { record, bundle };
}

// ---------------------------------------------------------------------------
// Event page
// ---------------------------------------------------------------------------

/**
 * The event detail for a downloaded event. Only recordings with a complete
 * local package are offered, and every server-side capability is closed.
 */
export async function readLocalEventDetail(
  catalogId: string,
  eventId: number,
): Promise<EventDetailResponse | null> {
  const record = await findLocalEvent(catalogId, eventId);
  if (!record) return null;
  const { bundle } = await readPackage(record);
  const detail = bundle?.eventDetail ?? synthesizeEventDetail(record);
  const localHashes = new Set(
    (await completeRecords())
      .filter((item) => item.catalogId === catalogId)
      .map((item) => item.hash),
  );
  const recordings = detail.recordings.filter((recording) =>
    localHashes.has(recording.audioHash),
  );
  return {
    ...detail,
    recordings,
    canViewArtworkCandidates: false,
    canManageArtwork: false,
    canPublishArtwork: false,
    canManageSources: false,
    latestDraftCandidate: null,
  };
}

/** Event detail for a package written before the payload was stored. */
function synthesizeEventDetail(record: DownloadRecord): EventDetailResponse {
  const event = record.event;
  const recording = record.recording;
  if (!event) {
    throw new Error('Download record has no event snapshot');
  }
  return {
    id: event.id,
    workflowGroupId: record.catalogId,
    title: event.title,
    location: event.locationName ? { id: 0, name: event.locationName } : null,
    dateYear: event.dateYear,
    dateMonth: event.dateMonth,
    dateDay: event.dateDay,
    sessionIndex: event.sessionIndex,
    sessionOrdinal: event.sessionOrdinal ?? 1,
    sessionCount: event.sessionCount ?? 1,
    description: null,
    // Older packages did not record release state; a download is a strong
    // signal the listener could reach the event, so present it as released.
    released: true,
    recordings: [
      {
        audioHash: record.hash,
        isPrimary: true,
        sortOrder: 0,
        title: recording?.title ?? '',
        artist: recording?.artist ?? null,
        durationHms: recording?.durationHms ?? null,
        verified: false,
        recorder: recording?.recorderName
          ? { id: 0, name: recording.recorderName }
          : null,
      },
    ],
    artworkStatus: event.publishedArtwork ? 'published' : 'none',
    publishedArtwork: event.publishedArtwork
      ? {
          id: event.publishedArtwork.id,
          publishedAt: event.publishedArtwork.publishedAt,
          assets: {
            square: { bytes: 0, sha256: '' },
            landscape: { bytes: 0, sha256: '' },
          },
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Recording entry
// ---------------------------------------------------------------------------

/**
 * The recording entry with the permissions a local package can honour: the
 * recording plays, a stored transcript can be read, nothing else is offered.
 */
export async function readLocalRecordingEntry(
  catalogId: string,
  hash: string,
): Promise<CatalogEntryWithPermissions | null> {
  const record = await findLocalRecording(catalogId, hash);
  if (!record) return null;
  const { bundle } = await readPackage(record);
  const stored = bundle?.entry ?? null;
  const entry = stored?.entry ?? synthesizeEntry(record);
  return {
    entry: {
      ...entry,
      // Server-side audio downloads are not available offline.
      hasArchivedAudio: false,
      hasOriginalAudio: false,
    },
    canViewTranscripts: bundle?.transcript !== null && bundle?.transcript !== undefined,
    canEditMetadata: false,
    canDownloadAudio: false,
    canDownloadOriginalAudio: false,
    canDownloadTranscripts: false,
    canSeeTranscriptVariants: false,
    // The overlay is administrative online; only a package written with that
    // permission recorded may show it offline.
    canSeeSpeakers:
      stored?.canSeeSpeakers === true &&
      bundle?.diarization !== null &&
      bundle?.diarization !== undefined,
  };
}

function synthesizeEntry(record: DownloadRecord): CatalogEntryResponse {
  const recording = record.recording;
  return {
    hash: record.hash,
    title: recording?.title ?? undefined,
    artist: recording?.artist ?? undefined,
    duration: recording?.durationHms ?? undefined,
    dateYear: recording?.dateYear ?? null,
    dateMonth: recording?.dateMonth ?? null,
    dateDay: recording?.dateDay ?? null,
    recorder: recording?.recorderName
      ? { id: 0, name: recording.recorderName }
      : null,
    hasArchived: true,
    hasMetadata: true,
    isActionable: true,
    isPublished: true,
    hasArchivedAudio: false,
    hasOriginalAudio: false,
  };
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

async function readTranscriptPackage(
  catalogId: string,
  hash: string,
): Promise<DownloadBundlePayload | null> {
  const record = await findLocalRecording(catalogId, hash);
  if (!record) return null;
  return (await readPackage(record)).bundle;
}

export async function readLocalTranscriptBackends(
  catalogId: string,
  hash: string,
): Promise<AvailableTranscripts | null> {
  const bundle = await readTranscriptPackage(catalogId, hash);
  if (!bundle) return null;
  const backend = bundle.transcript
    ? bundle.transcriptBackend ?? bundle.transcript.backend
    : null;
  return { hash, backends: backend ? [backend] : [] };
}

export async function readLocalTranscript(
  catalogId: string,
  hash: string,
): Promise<Transcript | null> {
  const bundle = await readTranscriptPackage(catalogId, hash);
  return bundle?.transcript ?? null;
}

export async function readLocalTranscriptFormats(
  catalogId: string,
  hash: string,
  backend: string,
): Promise<AvailableFormats | null> {
  const bundle = await readTranscriptPackage(catalogId, hash);
  if (!bundle) return null;
  // Transcript files are produced by the server; offline offers none.
  return { hash, backend, formats: [], canDownload: false };
}

export async function readLocalDiarizationBackends(
  catalogId: string,
  hash: string,
): Promise<AvailableDiarizations | null> {
  const bundle = await readTranscriptPackage(catalogId, hash);
  if (!bundle) return null;
  return { hash, backends: bundle.diarization ? ['pyannote'] : [] };
}

export async function readLocalDiarization(
  catalogId: string,
  hash: string,
): Promise<Diarization | null> {
  const bundle = await readTranscriptPackage(catalogId, hash);
  return bundle?.diarization ?? null;
}
