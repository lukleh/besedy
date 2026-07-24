import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalogData } from "@/components/catalog/catalog-list/hooks/use-catalog-data";
import type { CatalogResponse } from "@/components/catalog/catalog-list/types";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";

vi.mock("@/lib/api/fetch-json", () => ({
  ApiError: class MockApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
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

describe("useCatalogData", () => {
  const fetchJsonMock = vi.mocked(fetchJson);
  const groupKey = "catalog-key";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves cached catalog results while fresh visibility-scoped data resolves", async () => {
    const queryClient = createQueryClient();
    const cachedResponse: CatalogResponse = {
      groupId: "20260101_120000",
      groupLabel: "Catalog",
      totalAll: 5,
      total: 5,
      actionable: 5,
      verified: 2,
      entries: [
        {
          hash: "a".repeat(64),
          filename: "unpublished.wav",
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: false,
          hasArchivedAudio: true,
          hasOriginalAudio: true,
        },
      ],
      pagination: {
        page: 1,
        limit: 50,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      },
      accessLevel: "EDITOR",
    };

    const queryKey = [
      "catalog",
      groupKey,
      1,
      "all",
      "all",
      "all",
      "all",
      "all",
      "all",
      "all",
      "all",
      "all",
      "all",
      "all",
      "all",
      "date",
      "desc",
      "",
    ];
    queryClient.setQueryData(queryKey, cachedResponse);

    let resolveFetch: ((value: CatalogResponse) => void) | undefined;
    fetchJsonMock.mockImplementationOnce(
      () =>
        new Promise<CatalogResponse>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const { result } = renderHook(
      () =>
        useCatalogData({
          groupKey,
          activeCatalogId: "20260101_120000",
          statusFilter: "all",
          durationFilter: "all",
          verifiedFilter: "all",
          recorderFilter: "all",
          locationFilter: "all",
          partFilter: "all",
          dateYear: "all",
          dateMonth: "all",
          dateDay: "all",
          artistFilter: "all",
          albumFilter: "all",
          duplicatesFilter: "all",
          sortKey: "date",
          sortDir: "desc",
          page: 1,
          visibleColumnKeys: [],
          enabled: true,
        }),
      { wrapper: createWrapper(queryClient) }
    );

    expect(result.current.data).toEqual(cachedResponse);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(true);

    await act(async () => {
      resolveFetch?.({
        ...cachedResponse,
        totalAll: 1,
        total: 1,
        actionable: 1,
        verified: 0,
        entries: [
          {
            hash: "b".repeat(64),
            filename: "published.wav",
            hasArchived: true,
            hasMetadata: true,
            isActionable: true,
            isPublished: true,
            hasArchivedAudio: true,
            hasOriginalAudio: true,
          },
        ],
        accessLevel: "LISTENER",
      });
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data?.accessLevel).toBe("LISTENER");
      expect(result.current.data?.entries).toHaveLength(1);
      expect(result.current.data?.entries[0]?.isPublished).toBe(true);
    });
  });

  it("fails closed on cached auth error after a fresh catalog refetch is denied", async () => {
    const queryClient = createQueryClient();
    const cachedResponse: CatalogResponse = {
      groupId: "20260101_120000",
      groupLabel: "Catalog",
      totalAll: 5,
      total: 5,
      actionable: 5,
      verified: 2,
      entries: [
        {
          hash: "a".repeat(64),
          filename: "unpublished.wav",
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: false,
          hasArchivedAudio: true,
          hasOriginalAudio: true,
        },
      ],
      pagination: {
        page: 1,
        limit: 50,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      },
      accessLevel: "EDITOR",
    };

    queryClient.setQueryData(
      [
        "catalog",
        groupKey,
        1,
        "all",
        "all",
        "all",
        "all",
        "all",
        "all",
        "all",
        "all",
        "all",
        "all",
        "all",
        "all",
        "date",
        "desc",
        "",
      ],
      cachedResponse
    );
    fetchJsonMock.mockRejectedValueOnce(new ApiError("Access denied", 403));

    const { result } = renderHook(
      () =>
        useCatalogData({
          groupKey,
          activeCatalogId: "20260101_120000",
          statusFilter: "all",
          durationFilter: "all",
          verifiedFilter: "all",
          recorderFilter: "all",
          locationFilter: "all",
          partFilter: "all",
          dateYear: "all",
          dateMonth: "all",
          dateDay: "all",
          artistFilter: "all",
          albumFilter: "all",
          duplicatesFilter: "all",
          sortKey: "date",
          sortDir: "desc",
          page: 1,
          visibleColumnKeys: [],
          enabled: true,
        }),
      { wrapper: createWrapper(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(ApiError);
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("preserves mounted catalog data while an explicit refetch is in flight", async () => {
    const queryClient = createQueryClient();
    const initialResponse: CatalogResponse = {
      groupId: "20260101_120000",
      groupLabel: "Catalog",
      totalAll: 1,
      total: 1,
      actionable: 1,
      verified: 1,
      entries: [
        {
          hash: "c".repeat(64),
          filename: "published.wav",
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: true,
          hasArchivedAudio: true,
          hasOriginalAudio: true,
        },
      ],
      pagination: {
        page: 1,
        limit: 50,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      },
      accessLevel: "LISTENER",
    };

    let resolveRefetch: ((value: CatalogResponse) => void) | undefined;
    fetchJsonMock
      .mockResolvedValueOnce(initialResponse)
      .mockImplementationOnce(
        () =>
          new Promise<CatalogResponse>((resolve) => {
            resolveRefetch = resolve;
          })
      );

    const { result } = renderHook(
      () =>
        useCatalogData({
          groupKey,
          activeCatalogId: "20260101_120000",
          statusFilter: "all",
          durationFilter: "all",
          verifiedFilter: "all",
          recorderFilter: "all",
          locationFilter: "all",
          partFilter: "all",
          dateYear: "all",
          dateMonth: "all",
          dateDay: "all",
          artistFilter: "all",
          albumFilter: "all",
          duplicatesFilter: "all",
          sortKey: "date",
          sortDir: "desc",
          page: 1,
          visibleColumnKeys: [],
          enabled: true,
        }),
      { wrapper: createWrapper(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.data?.accessLevel).toBe("LISTENER");
    });

    act(() => {
      void result.current.refetch();
    });

    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    });

    expect(result.current.data?.accessLevel).toBe("LISTENER");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(true);

    await act(async () => {
      resolveRefetch?.({
        ...initialResponse,
        verified: 0,
      });
    });

    await waitFor(() => {
      expect(result.current.data?.verified).toBe(0);
      expect(result.current.isLoading).toBe(false);
    });
  });
});
