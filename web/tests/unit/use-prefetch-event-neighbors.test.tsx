import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefetchEventNeighbors } from '@/hooks/use-prefetch-event-neighbors';

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  prefetch: vi.fn(),
  imageUrls: [] as string[],
}));

vi.mock('@/lib/api/fetch-json', () => ({ fetchJson: mocks.fetchJson }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ prefetch: mocks.prefetch }) }));

const CATALOG = 'cat';
const HASH = 'a'.repeat(64);
const STATE = {
  releasedFilter: 'all',
  locationFilter: 'all',
  dateYearFilter: 'all',
  sortKey: 'date',
  sortDir: 'desc',
} as const;

function eventDetail(id: number) {
  return {
    id,
    recordings: [
      { audioHash: 'b'.repeat(64), isPrimary: false },
      { audioHash: HASH, isPrimary: true },
    ],
    publishedArtwork: { id: `art-${id}` },
  };
}

// Loaded images stay retained for the module's lifetime, so each test uses
// its own neighbor.
function setup(neighborId: number, states: (typeof STATE)[] = [STATE]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(() => usePrefetchEventNeighbors(CATALOG, [neighborId], states), { wrapper });
  return queryClient;
}

function setSaveData(saveData: boolean) {
  Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData } });
}

describe('usePrefetchEventNeighbors', () => {
  beforeEach(() => {
    mocks.fetchJson.mockReset();
    mocks.prefetch.mockReset();
    mocks.imageUrls = [];
    setSaveData(false);
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    vi.stubGlobal(
      'Image',
      class {
        decoding = '';
        set src(url: string) {
          mocks.imageUrls.push(url);
        }
      },
    );
    mocks.fetchJson.mockImplementation(async (url: string) => {
      const detail = /^\/api\/catalogs\/cat\/events\/(\d+)$/.exec(url);
      if (detail) return eventDetail(Number(detail[1]));
      if (url.endsWith('/audio/sources')) return { hash: HASH, sources: [], defaultSource: 'archived' };
      if (url.endsWith('/entry')) return { entry: { hash: HASH } };
      if (url.includes('sequence=true')) return { previous: null, next: null, position: 1, total: 1 };
      throw new Error(`unexpected request ${url}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prepares the neighbor route, its data and its artwork for an instant switch', async () => {
    const queryClient = setup(6);

    await waitFor(() => expect(mocks.imageUrls).toHaveLength(1));
    expect(mocks.prefetch).toHaveBeenCalledWith('/catalog/cat/event/6', { kind: 'full' });
    expect(mocks.imageUrls[0]).toBe('/api/catalogs/cat/events/6/artwork?variant=square&v=art-6');
    await waitFor(() =>
      expect(queryClient.getQueryData(['catalog-entry', HASH, CATALOG])).toEqual({ entry: { hash: HASH } }),
    );
    expect(queryClient.getQueryData(['catalog-event-detail', 6])).toEqual(eventDetail(6));
    expect(queryClient.getQueryData(['audio-variants', HASH, CATALOG])).toMatchObject({ hash: HASH });
  });

  it('never loads audio or transcripts ahead of time', async () => {
    setup(7);
    await waitFor(() => expect(mocks.imageUrls).toHaveLength(1));
    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalledTimes(4));

    const urls = mocks.fetchJson.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => /transcript|\/audio(?!\/sources)/.test(url))).toEqual([]);
  });

  it("preloads the neighbor's own neighbors in every list order its page may ask for", async () => {
    const filtered = { ...STATE, locationFilter: '7' } as unknown as typeof STATE;
    setup(9, [filtered, STATE]);

    await waitFor(() => expect(mocks.imageUrls).toHaveLength(1));
    const sequenceUrls = mocks.fetchJson.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('sequence=true') && url.includes('current=9'));
    expect(sequenceUrls).toHaveLength(2);
    expect(sequenceUrls.some((url) => url.includes('location=7'))).toBe(true);
  });

  it('loads nothing ahead when the device asks to save data', async () => {
    vi.useFakeTimers();
    try {
      setSaveData(true);
      setup(8);
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.prefetch).not.toHaveBeenCalled();
    expect(mocks.fetchJson).not.toHaveBeenCalled();
    expect(mocks.imageUrls).toEqual([]);
  });
});
