import { beforeEach, describe, expect, it } from 'vitest';
import { localEventRows } from '@/components/offline/local-event-list';
import type { DownloadRecord } from '@/lib/offline/downloads-db';

const CATALOG = '20260101_120000';

function record(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  const hash = overrides.hash ?? 'a'.repeat(64);
  return {
    key: `${CATALOG}:${hash}`,
    catalogId: CATALOG,
    catalogLabel: 'Winter',
    hash,
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
      sessionOrdinal: 1,
      sessionCount: 2,
      publishedArtwork: null,
    },
    recording: {
      title: 'Talk',
      artist: null,
      durationHms: '01:00:00',
      recorderName: 'Zoom',
      dateYear: 2026,
      dateMonth: 5,
      dateDay: 1,
    },
    audioUrl: `/api/catalogs/${CATALOG}/recordings/${hash}/audio`,
    audioCacheKey: `/api/catalogs/${CATALOG}/recordings/${hash}/audio`,
    status: 'complete',
    progress: 100,
    bytesLoaded: 1,
    totalBytes: 1,
    error: null,
    resumeOnReconnect: false,
    transcriptBackend: null,
    hasArtwork: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: 1,
    ...overrides,
  };
}

describe('localEventRows', () => {
  beforeEach(() => {
    // The shared setup stubs localStorage with no-op spies; these rows read
    // real saved positions, so give them a working store.
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      },
    });
  });

  it('builds one normal list row per completed downloaded event of the catalog', () => {
    const rows = localEventRows(
      [
        record(),
        record({ hash: 'b'.repeat(64), status: 'paused', eventKey: `${CATALOG}:8` }),
        record({ hash: 'c'.repeat(64), catalogId: 'other', key: 'other:c' }),
        record({ hash: 'd'.repeat(64), eventKey: null, event: null }),
      ],
      CATALOG,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 7,
      location: { name: 'Prague' },
      sessionOrdinal: 1,
      sessionCount: 2,
      primaryAudioHash: 'a'.repeat(64),
      playback: null,
    });
  });

  it('orders newest events first and folds a second recording of the same event into one row', () => {
    const rows = localEventRows(
      [
        record(),
        record({
          hash: 'b'.repeat(64),
          eventKey: `${CATALOG}:9`,
          event: {
            id: 9,
            title: null,
            locationName: 'Brno',
            dateYear: 2026,
            dateMonth: 6,
            dateDay: 3,
            sessionIndex: 1,
            publishedArtwork: null,
          },
        }),
        record({ hash: 'c'.repeat(64), createdAt: 2 }),
      ],
      CATALOG,
    );
    expect(rows.map((row) => row.id)).toEqual([9, 7]);
    expect(rows[1].primaryAudioHash).toBe('c'.repeat(64));
  });

  it('derives listening progress from the browser-saved position and the recording length', () => {
    const hash = 'a'.repeat(64);
    localStorage.setItem(`besedy-playback-${hash}`, '1800');
    const rows = localEventRows([record({ hash })], CATALOG);
    expect(rows[0].playback).toMatchObject({
      positionSec: 1800,
      durationSec: 3600,
      percent: 50,
      completed: false,
    });
  });
});
