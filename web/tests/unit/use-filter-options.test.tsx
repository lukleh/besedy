import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useFilterOptions,
  type FilterOptionsResponse,
} from "@/hooks/use-filter-options";
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

describe("useFilterOptions", () => {
  const fetchJsonMock = vi.mocked(fetchJson);
  const groupId = "20260101_120000";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves cached filter options while fresh listener-scoped options resolve", async () => {
    const queryClient = createQueryClient();
    const cachedOptions: FilterOptionsResponse = {
      groupId,
      totalMatching: 3,
      options: {
        recorders: [
          { id: 1, name: "Visible Recorder", count: 1 },
          { id: 99, name: "Hidden Recorder", count: 2 },
        ],
        locations: [],
        albums: [],
        parts: [],
        artists: [],
        duplicates: [],
        years: [],
        months: [],
        days: [],
        statuses: [
          { value: "ready", count: 1 },
          { value: "incomplete", count: 2 },
        ],
        durations: [],
        verified: [],
      },
    };

    queryClient.setQueryData(
      ["catalog-filter-options", groupId, {}],
      cachedOptions
    );

    let resolveFetch: ((value: FilterOptionsResponse) => void) | undefined;
    fetchJsonMock.mockImplementationOnce(
      () =>
        new Promise<FilterOptionsResponse>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const { result } = renderHook(
      () =>
        useFilterOptions({
          groupId,
          filters: {
            status: "all",
            duration: "all",
            verified: "all",
          },
        }),
      { wrapper: createWrapper(queryClient) }
    );

    expect(result.current.data).toEqual(cachedOptions);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(true);

    await act(async () => {
      resolveFetch?.({
        ...cachedOptions,
        totalMatching: 1,
        options: {
          ...cachedOptions.options,
          recorders: [{ id: 1, name: "Visible Recorder", count: 1 }],
          statuses: [],
        },
      });
    });

    await waitFor(() => {
      expect(result.current.data?.totalMatching).toBe(1);
      expect(result.current.data?.options.recorders).toEqual([
        { id: 1, name: "Visible Recorder", count: 1 },
      ]);
      expect(result.current.data?.options.statuses).toEqual([]);
    });
  });

  it("fails closed on cached auth error after a fresh filter-options refetch is denied", async () => {
    const queryClient = createQueryClient();
    const cachedOptions: FilterOptionsResponse = {
      groupId,
      totalMatching: 3,
      options: {
        recorders: [
          { id: 1, name: "Visible Recorder", count: 1 },
          { id: 99, name: "Hidden Recorder", count: 2 },
        ],
        locations: [],
        albums: [],
        parts: [],
        artists: [],
        duplicates: [],
        years: [],
        months: [],
        days: [],
        statuses: [
          { value: "ready", count: 1 },
          { value: "incomplete", count: 2 },
        ],
        durations: [],
        verified: [],
      },
    };

    queryClient.setQueryData(
      ["catalog-filter-options", groupId, {}],
      cachedOptions
    );
    fetchJsonMock.mockRejectedValueOnce(new ApiError("Access denied", 403));

    const { result } = renderHook(
      () =>
        useFilterOptions({
          groupId,
          filters: {
            status: "all",
            duration: "all",
            verified: "all",
          },
        }),
      { wrapper: createWrapper(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(ApiError);
    });

    expect(result.current.data).toBeUndefined();
  });

  it("preserves mounted filter options while an explicit refetch is in flight", async () => {
    const queryClient = createQueryClient();
    const initialOptions: FilterOptionsResponse = {
      groupId,
      totalMatching: 1,
      options: {
        recorders: [{ id: 1, name: "Visible Recorder", count: 1 }],
        locations: [],
        albums: [],
        parts: [],
        artists: [],
        duplicates: [],
        years: [],
        months: [],
        days: [],
        statuses: [{ value: "ready", count: 1 }],
        durations: [],
        verified: [],
      },
    };

    let resolveRefetch: ((value: FilterOptionsResponse) => void) | undefined;
    fetchJsonMock
      .mockResolvedValueOnce(initialOptions)
      .mockImplementationOnce(
        () =>
          new Promise<FilterOptionsResponse>((resolve) => {
            resolveRefetch = resolve;
          })
      );

    const { result } = renderHook(
      () =>
        useFilterOptions({
          groupId,
          filters: {
            status: "all",
            duration: "all",
            verified: "all",
          },
        }),
      { wrapper: createWrapper(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.data?.totalMatching).toBe(1);
    });

    act(() => {
      void result.current.refetch();
    });

    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    });

    expect(result.current.data?.totalMatching).toBe(1);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(true);

    await act(async () => {
      resolveRefetch?.({
        ...initialOptions,
        totalMatching: 2,
        options: {
          ...initialOptions.options,
          recorders: [
            { id: 1, name: "Visible Recorder", count: 1 },
            { id: 2, name: "Another Recorder", count: 1 },
          ],
        },
      });
    });

    await waitFor(() => {
      expect(result.current.data?.totalMatching).toBe(2);
      expect(result.current.isLoading).toBe(false);
    });
  });
});
