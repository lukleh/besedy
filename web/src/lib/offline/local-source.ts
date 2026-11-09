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
import { isNetworkFailure } from '@/lib/api/fetch-json';
import type {
  AvailableDiarizations,
  AvailableFormats,
  AvailableTranscripts,
  Diarization,
  Transcript,
} from '@/components/transcript/transcript-viewer-types';
import type { CatalogEntryWithPermissions } from '@/types/catalog';
import type { EventDetailResponse } from '@/types/event-detail';
import { downloadManager } from './download-manager';
import {
  getDownloadBundle,
  isCurrentDownloadBundle,
  makeDownloadKey,
  makeEventKey,
  type DownloadBundlePayload,
  type DownloadRecord,
} from './downloads-db';

// A request that never reached the server (offline, DNS, dropped connection);
// server verdicts keep their meaning. Defined with fetch-json, re-exported here.
export { isNetworkFailure };

/**
 * Run `request`; if it fails because the network is unreachable and `local`
 * can answer from a complete package, return that answer instead. Every other
 * error propagates unchanged.
 *
 * Queries that use this must set `networkMode: "offlineFirst"`; React Query's
 * default mode pauses the query function while offline, before it can run.
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
  return records.find((record) => record.eventKey === eventKey) ?? null;
}

async function readPackage(
  record: DownloadRecord,
): Promise<DownloadBundlePayload | null> {
  const bundle = await getDownloadBundle(record.key).catch(() => undefined);
  return isCurrentDownloadBundle(record, bundle) ? bundle : null;
}

// ---------------------------------------------------------------------------
// Event page
// ---------------------------------------------------------------------------

/**
 * The event detail for a downloaded event. Its saved capture stays the playback
 * identity even if another capture is now preferred or is also downloaded.
 */
export async function readLocalEventDetail(
  catalogId: string,
  eventId: number,
): Promise<EventDetailResponse | null> {
  const record = await findLocalEvent(catalogId, eventId);
  if (!record) return null;
  const bundle = await readPackage(record);
  const detail = bundle?.eventDetail;
  if (!detail) return null;
  const recording = detail.recordings.find(
    (item) => item.audioHash === record.hash,
  );
  if (!recording) return null;
  return {
    ...detail,
    recordings: [recording],
    canViewArtworkCandidates: false,
    canManageArtwork: false,
    canPublishArtwork: false,
    canManageSources: false,
    canEditMetadata: false,
    latestDraftCandidate: null,
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
  const bundle = await readPackage(record);
  if (!bundle) return null;
  const stored = bundle.entry;
  return {
    entry: {
      ...stored.entry,
      // Server-side audio downloads are not available offline.
      hasArchivedAudio: false,
      hasOriginalAudio: false,
    },
    canViewTranscripts:
      bundle?.transcript !== null && bundle?.transcript !== undefined,
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

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

async function readTranscriptPackage(
  catalogId: string,
  hash: string,
): Promise<DownloadBundlePayload | null> {
  const record = await findLocalRecording(catalogId, hash);
  if (!record) return null;
  return readPackage(record);
}

export async function readLocalTranscriptBackends(
  catalogId: string,
  hash: string,
): Promise<AvailableTranscripts | null> {
  const bundle = await readTranscriptPackage(catalogId, hash);
  if (!bundle) return null;
  const backend = bundle.transcript ? bundle.transcriptBackend : null;
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
