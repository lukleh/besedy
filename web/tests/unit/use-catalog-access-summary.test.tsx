import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCatalogAccessSummary } from '@/hooks/use-catalog-access-summary';
import { ApiError, fetchJson } from '@/lib/api/fetch-json';

vi.mock('@/lib/api/fetch-json', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/fetch-json')>()),
  fetchJson: vi.fn(),
}));

function renderSummary() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useCatalogAccessSummary('catalog-a'), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

describe('useCatalogAccessSummary', () => {
  const fetchJsonMock = vi.mocked(fetchJson);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a refusal as no access', async () => {
    fetchJsonMock.mockRejectedValue(new ApiError('Not found', 404));

    const { result } = renderSummary();

    await waitFor(() => {
      expect(result.current.data).toEqual({
        canManageAccess: false,
        canViewCorrectionOverview: false,
      });
    });
  });

  it.each([
    ['a dropped connection', new TypeError('Failed to fetch')],
    ['a server error', new ApiError('Unavailable', 503)],
  ])('fails on %s instead of answering no access', async (_name, error) => {
    fetchJsonMock.mockRejectedValue(error);

    const { result } = renderSummary();

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.data).toBeUndefined();
  });

  it('asks again after a temporary failure and recovers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const granted = { canManageAccess: true, canViewCorrectionOverview: true };
    fetchJsonMock
      .mockRejectedValueOnce(new ApiError('Unavailable', 503))
      .mockResolvedValue(granted);

    const { result } = renderSummary();

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);

    await waitFor(() => {
      expect(result.current.data).toEqual(granted);
    });

    // An answered lookup is not polled.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
  });
});
