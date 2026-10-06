import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAlbums,
  useLocations,
  useRecorders,
} from '@/hooks/use-metadata-enums';
import { fetchJson } from '@/lib/api/fetch-json';

vi.mock('@/lib/api/fetch-json', () => ({
  fetchJson: vi.fn(),
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('metadata enum hooks', () => {
  const fetchJsonMock = vi.mocked(fetchJson);

  beforeEach(() => {
    vi.clearAllMocks();
    fetchJsonMock.mockResolvedValue([]);
  });

  it.each([
    ['recorders', useRecorders],
    ['locations', useLocations],
    ['albums', useAlbums],
  ] as const)('scopes %s by catalog', async (resource, useHook) => {
    const queryClient = createQueryClient();
    const { rerender } = renderHook(
      ({ catalogId }: { catalogId: string }) => useHook(catalogId),
      {
        initialProps: { catalogId: 'catalog-a' },
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledWith(
        `/api/catalogs/catalog-a/metadata/${resource}`,
        expect.any(Object),
      );
    });

    rerender({ catalogId: 'catalog-b' });

    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledWith(
        `/api/catalogs/catalog-b/metadata/${resource}`,
        expect.any(Object),
      );
    });

    expect(
      queryClient.getQueryCache().find({
        queryKey: ['metadata', resource, 'catalog-a'],
      }),
    ).toBeDefined();
    expect(
      queryClient.getQueryCache().find({
        queryKey: ['metadata', resource, 'catalog-b'],
      }),
    ).toBeDefined();
  });
});
