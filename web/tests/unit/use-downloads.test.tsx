import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloadedEvents } from '@/hooks/use-downloads';
import type { DownloadRecord } from '@/lib/offline/download-manager';

const records: DownloadRecord[] = [];
const clientSnapshot = {
  supported: true,
  hydrated: true,
  records,
  activeKey: null,
  storage: null,
};
const serverSnapshot = {
  supported: false,
  hydrated: false,
  records: [],
  activeKey: null,
  storage: null,
};

vi.mock('@/lib/offline/download-manager', () => ({
  downloadManager: {
    subscribe: () => () => undefined,
    getSnapshot: () => clientSnapshot,
    getServerSnapshot: () => serverSnapshot,
  },
}));

const CATALOG = '20260101_000000';

function record(overrides: Partial<DownloadRecord>): DownloadRecord {
  return {
    key: `${CATALOG}:${'a'.repeat(64)}`,
    catalogId: CATALOG,
    catalogLabel: null,
    hash: 'a'.repeat(64),
    userId: 'user-1',
    eventKey: null,
    event: null,
    recording: null,
    audioUrl: null,
    audioCacheKey: null,
    status: 'complete',
    progress: 100,
    bytesLoaded: 1,
    totalBytes: 1,
    error: null,
    resumeOnReconnect: false,
    transcriptBackend: null,
    hasPoster: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: 1,
    ...overrides,
  };
}

describe('useDownloadedEvents', () => {
  beforeEach(() => {
    records.length = 0;
  });

  it('uses an event key even when the optional event snapshot is absent', () => {
    records.push(record({ eventKey: `${CATALOG}:42` }));

    const { result } = renderHook(() => useDownloadedEvents(CATALOG));

    expect(result.current.get(42)).toBe('complete');
  });

  it('marks an event when its primary recording was downloaded directly', () => {
    const hash = 'b'.repeat(64);
    records.push(record({ hash }));

    const { result } = renderHook(() =>
      useDownloadedEvents(CATALOG, [{ id: 42, primaryAudioHash: hash }]),
    );

    expect(result.current.get(42)).toBe('complete');
  });

  it('continues to recognize older records that have only an event snapshot', () => {
    records.push(
      record({
        event: {
          id: 42,
          title: null,
          locationName: null,
          dateYear: 2026,
          dateMonth: null,
          dateDay: null,
          sessionIndex: 1,
          publishedPoster: null,
        },
      }),
    );

    const { result } = renderHook(() => useDownloadedEvents(CATALOG));

    expect(result.current.get(42)).toBe('complete');
  });
});
