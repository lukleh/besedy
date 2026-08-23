import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventSequenceNavigation } from '@/hooks/use-event-sequence-navigation';

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  isDesktop: false,
}));

vi.mock('@/lib/api/fetch-json', () => ({
  fetchJson: mocks.fetchJson,
}));

vi.mock('@/hooks/use-media-query', () => ({
  useIsDesktop: () => mocks.isDesktop,
}));

const CATALOG_ID = '20260101_120000';
const STORAGE_KEY = `besedy-event-filters-${CATALOG_ID}`;
const sequence = {
  previous: null,
  next: {
    id: 2,
    dateYear: 2024,
    dateMonth: 1,
    dateDay: 1,
    location: { id: 2, name: 'Brno' },
  },
  position: 1,
  total: 2,
};
const LIST_CAPABILITIES = {
  showAllColumns: false,
  showReleaseState: false,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

describe('useEventSequenceNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktop = false;
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    mocks.fetchJson.mockResolvedValue(sequence);
  });

  it('normalizes a desktop-only saved sort to newest-first date order on mobile', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === STORAGE_KEY
        ? JSON.stringify({ sortKey: 'location', sortDir: 'asc' })
        : null,
    );

    renderHook(
      () =>
        useEventSequenceNavigation(CATALOG_ID, 1, LIST_CAPABILITIES),
      {
      wrapper: createWrapper(),
      },
    );

    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalledTimes(1));
    const url = String(mocks.fetchJson.mock.calls[0][0]);
    expect(url).toContain('sort=date');
    expect(url).toContain('dir=desc');
    expect(url).toContain('current=1');
  });

  it('requests only the current event neighborhood when the event changes', async () => {
    mocks.fetchJson
      .mockResolvedValueOnce(sequence)
      .mockResolvedValueOnce({
        previous: {
          id: 1,
          dateYear: 2025,
          dateMonth: 1,
          dateDay: 1,
          location: { id: 1, name: 'Praha' },
        },
        next: null,
        position: 2,
        total: 2,
      });
    const { result, rerender } = renderHook(
      ({ eventId }) =>
        useEventSequenceNavigation(CATALOG_ID, eventId, LIST_CAPABILITIES),
      {
        initialProps: { eventId: 1 },
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => expect(result.current.position).toBe(1));
    rerender({ eventId: 2 });

    await waitFor(() => expect(result.current.position).toBe(2));
    expect(result.current.previous?.id).toBe(1);
    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    expect(String(mocks.fetchJson.mock.calls[1][0])).toContain('current=2');
  });

  it('drops filters and sorts that are not visible to the current user', async () => {
    mocks.isDesktop = true;
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === STORAGE_KEY
        ? JSON.stringify({
            releasedFilter: 'false',
            sortKey: 'recordingCount',
            sortDir: 'asc',
          })
        : null,
    );

    renderHook(
      () =>
        useEventSequenceNavigation(CATALOG_ID, 1, LIST_CAPABILITIES),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalledTimes(1));
    const url = String(mocks.fetchJson.mock.calls[0][0]);
    expect(url).toContain('sort=date');
    expect(url).toContain('dir=asc');
    expect(url).not.toContain('released=');
  });
});
