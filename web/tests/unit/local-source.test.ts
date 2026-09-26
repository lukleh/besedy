import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/fetch-json';
import type {
  DownloadBundlePayload,
  DownloadRecord,
} from '@/lib/offline/downloads-db';
import type { EventDetailResponse } from '@/types/event-detail';

const mocks = vi.hoisted(() => ({
  records: [] as DownloadRecord[],
  bundles: new Map<string, DownloadBundlePayload>(),
  hydrate: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/offline/download-manager', () => ({
  downloadManager: {
    hydrate: mocks.hydrate,
    getSnapshot: () => ({
      supported: true,
      hydrated: true,
      records: mocks.records,
      activeKey: null,
      storage: null,
    }),
  },
}));

vi.mock('@/lib/offline/downloads-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/offline/downloads-db')>();
  return {
    ...actual,
    getDownloadBundle: vi.fn(async (key: string) => mocks.bundles.get(key)),
  };
});

const CATALOG = '20260101_120000';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

function record(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    key: `${CATALOG}:${HASH}`,
    catalogId: CATALOG,
    catalogLabel: 'Winter',
    hash: HASH,
    userId: 'u1',
    eventKey: `${CATALOG}:7`,
    event: {
      id: 7,
      title: 'Evening talk',
      locationName: 'Prague',
      dateYear: 2026,
      dateMonth: 5,
      dateDay: 1,
      sessionIndex: 1,
      publishedArtwork: { id: 'art-1', publishedAt: '2026-05-01T00:00:00.000Z' },
    },
    recording: {
      title: 'Talk',
      artist: 'Speaker',
      durationHms: '01:00:00',
      recorderName: 'Zoom',
      dateYear: 2026,
      dateMonth: 5,
      dateDay: 1,
    },
    audioUrl: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
    audioCacheKey: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
    status: 'complete',
    progress: 100,
    bytesLoaded: 10,
    totalBytes: 10,
    error: null,
    resumeOnReconnect: false,
    transcriptBackend: null,
    hasArtwork: true,
    createdAt: 1,
    updatedAt: 1,
    completedAt: 1,
    ...overrides,
  };
}

function eventDetail(): EventDetailResponse {
  return {
    id: 7,
    workflowGroupId: CATALOG,
    title: 'Evening talk',
    location: { id: 1, name: 'Prague' },
    dateYear: 2026,
    dateMonth: 5,
    dateDay: 1,
    sessionIndex: 1,
    sessionOrdinal: 1,
    sessionCount: 2,
    description: 'About winter',
    released: true,
    canManageSources: true,
    canViewArtworkCandidates: true,
    latestDraftCandidate: { id: 'draft', label: null, createdAt: '2026-05-02' },
    recordings: [
      {
        audioHash: HASH,
        isPrimary: true,
        sortOrder: 0,
        title: 'A',
        artist: null,
        durationHms: '01:00:00',
        verified: true,
        recorder: { id: 1, name: 'Zoom' },
      },
      {
        audioHash: OTHER_HASH,
        isPrimary: false,
        sortOrder: 1,
        title: 'B',
        artist: null,
        durationHms: null,
        verified: true,
        recorder: null,
      },
    ],
  };
}

function bundle(overrides: Partial<DownloadBundlePayload> = {}): DownloadBundlePayload {
  return {
    key: `${CATALOG}:${HASH}`,
    transcriptBackend: null,
    transcript: null,
    diarization: null,
    artwork: null,
    updatedAt: 1,
    ...overrides,
  };
}

async function loadSource() {
  return import('@/lib/offline/local-source');
}

describe('local content source', () => {
  beforeEach(() => {
    mocks.records = [];
    mocks.bundles.clear();
    mocks.hydrate.mockClear();
  });

  describe('withLocalFallback', () => {
    it('returns the network answer when the request succeeds', async () => {
      const { withLocalFallback } = await loadSource();
      const local = vi.fn(async () => 'local');
      await expect(withLocalFallback(async () => 'network', local)).resolves.toBe('network');
      expect(local).not.toHaveBeenCalled();
    });

    it('falls back to the package when the request itself fails', async () => {
      const { withLocalFallback } = await loadSource();
      const result = await withLocalFallback(
        async () => {
          throw new TypeError('Failed to fetch');
        },
        async () => 'local',
      );
      expect(result).toBe('local');
    });

    it('keeps server verdicts intact instead of hiding them behind a package', async () => {
      const { withLocalFallback } = await loadSource();
      const local = vi.fn(async () => 'local');
      await expect(
        withLocalFallback(async () => {
          throw new ApiError('Forbidden', 403);
        }, local),
      ).rejects.toBeInstanceOf(ApiError);
      expect(local).not.toHaveBeenCalled();
    });

    it('rethrows the network failure when no package can answer', async () => {
      const { withLocalFallback } = await loadSource();
      await expect(
        withLocalFallback(
          async () => {
            throw new TypeError('Failed to fetch');
          },
          async () => null,
        ),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe('readLocalEventDetail', () => {
    it('serves the stored payload with server-only capabilities closed and only downloaded recordings', async () => {
      mocks.records = [record()];
      mocks.bundles.set(`${CATALOG}:${HASH}`, bundle({ eventDetail: eventDetail() }));
      const { readLocalEventDetail } = await loadSource();

      const detail = await readLocalEventDetail(CATALOG, 7);

      expect(detail?.description).toBe('About winter');
      expect(detail?.recordings.map((item) => item.audioHash)).toEqual([HASH]);
      expect(detail?.canManageSources).toBe(false);
      expect(detail?.canViewArtworkCandidates).toBe(false);
      expect(detail?.latestDraftCandidate).toBeNull();
    });

    it('synthesizes a page from the snapshots of a package written before the payload was stored', async () => {
      mocks.records = [record()];
      const { readLocalEventDetail } = await loadSource();

      const detail = await readLocalEventDetail(CATALOG, 7);

      expect(detail).toMatchObject({
        id: 7,
        title: 'Evening talk',
        location: { name: 'Prague' },
        sessionOrdinal: 1,
        sessionCount: 1,
      });
      expect(detail?.recordings).toHaveLength(1);
      expect(detail?.recordings[0]).toMatchObject({
        audioHash: HASH,
        recorder: { name: 'Zoom' },
      });
      expect(detail?.publishedArtwork?.id).toBe('art-1');
    });

    it('finds a legacy record through its event snapshot when no event key was stored', async () => {
      mocks.records = [record({ eventKey: null })];
      const { readLocalEventDetail } = await loadSource();
      expect((await readLocalEventDetail(CATALOG, 7))?.id).toBe(7);
    });

    it('answers nothing for an event that was not downloaded or is not complete', async () => {
      mocks.records = [record({ status: 'paused' })];
      const { readLocalEventDetail } = await loadSource();
      expect(await readLocalEventDetail(CATALOG, 7)).toBeNull();
      expect(await readLocalEventDetail(CATALOG, 8)).toBeNull();
    });
  });

  describe('readLocalRecordingEntry', () => {
    it('derives permissions from the package instead of the stored online answer', async () => {
      mocks.records = [record()];
      mocks.bundles.set(
        `${CATALOG}:${HASH}`,
        bundle({
          transcript: { backend: 'whisperx/large', segments: [] },
          diarization: { hash: HASH, model: 'pyannote', numSpeakers: 1, segments: [] },
          entry: {
            entry: {
              hash: HASH,
              title: 'Talk',
              hasArchived: true,
              hasMetadata: true,
              isActionable: true,
              isPublished: true,
              hasArchivedAudio: true,
              hasOriginalAudio: true,
            },
            canViewTranscripts: true,
            canEditMetadata: true,
            canDownloadAudio: true,
            canDownloadTranscripts: true,
            canSeeSpeakers: true,
          },
        }),
      );
      const { readLocalRecordingEntry } = await loadSource();

      const result = await readLocalRecordingEntry(CATALOG, HASH);

      expect(result?.entry.title).toBe('Talk');
      expect(result?.entry.hasArchivedAudio).toBe(false);
      expect(result?.canEditMetadata).toBe(false);
      expect(result?.canDownloadAudio).toBe(false);
      expect(result?.canDownloadTranscripts).toBe(false);
      expect(result?.canViewTranscripts).toBe(true);
      expect(result?.canSeeSpeakers).toBe(true);
    });

    it('keeps the speaker overlay closed unless the package recorded that permission', async () => {
      mocks.records = [record()];
      mocks.bundles.set(
        `${CATALOG}:${HASH}`,
        bundle({
          transcript: { backend: 'whisperx/large', segments: [] },
          diarization: { hash: HASH, model: 'pyannote', numSpeakers: 1, segments: [] },
        }),
      );
      const { readLocalRecordingEntry } = await loadSource();
      const result = await readLocalRecordingEntry(CATALOG, HASH);
      expect(result?.canSeeSpeakers).toBe(false);
      expect(result?.canViewTranscripts).toBe(true);
    });

    it('synthesizes a playable entry from the recording snapshot', async () => {
      mocks.records = [record()];
      const { readLocalRecordingEntry } = await loadSource();
      const result = await readLocalRecordingEntry(CATALOG, HASH);
      expect(result?.entry).toMatchObject({
        hash: HASH,
        title: 'Talk',
        duration: '01:00:00',
        isActionable: true,
        recorder: { name: 'Zoom' },
        location: { name: 'Prague' },
      });
      expect(result?.canViewTranscripts).toBe(false);
    });

    it('leaves the location empty for a download made outside an event', async () => {
      mocks.records = [record({ eventKey: null, event: null })];
      const { readLocalRecordingEntry } = await loadSource();
      const result = await readLocalRecordingEntry(CATALOG, HASH);
      expect(result?.entry.location).toBeNull();
    });
  });

  describe('transcript readers', () => {
    it('offers exactly the stored transcript and no server-side files', async () => {
      mocks.records = [record({ transcriptBackend: 'whisperx/large' })];
      mocks.bundles.set(
        `${CATALOG}:${HASH}`,
        bundle({
          transcriptBackend: 'whisperx/large',
          transcript: { backend: 'whisperx/large', segments: [] },
        }),
      );
      const source = await loadSource();

      expect(await source.readLocalTranscriptBackends(CATALOG, HASH)).toEqual({
        hash: HASH,
        backends: ['whisperx/large'],
      });
      expect((await source.readLocalTranscript(CATALOG, HASH))?.backend).toBe('whisperx/large');
      expect(await source.readLocalTranscriptFormats(CATALOG, HASH, 'whisperx/large')).toEqual({
        hash: HASH,
        backend: 'whisperx/large',
        formats: [],
        canDownload: false,
      });
      expect(await source.readLocalDiarizationBackends(CATALOG, HASH)).toEqual({
        hash: HASH,
        backends: [],
      });
    });

    it('reports no transcript for a package that stored none', async () => {
      mocks.records = [record()];
      mocks.bundles.set(`${CATALOG}:${HASH}`, bundle());
      const source = await loadSource();
      expect(await source.readLocalTranscriptBackends(CATALOG, HASH)).toEqual({
        hash: HASH,
        backends: [],
      });
      expect(await source.readLocalTranscript(CATALOG, HASH)).toBeNull();
    });
  });
});
