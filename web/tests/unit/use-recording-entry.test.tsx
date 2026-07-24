import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingEntry } from "@/hooks/use-recording-entry";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import type { CatalogEntryWithPermissions } from "@/types/catalog";

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

describe("useRecordingEntry", () => {
  const fetchJsonMock = vi.mocked(fetchJson);
  const catalogId = "20260101_120000";
  const hash = "a".repeat(64);
  const groupKey = "catalog-key";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves cached editor permissions until a fresh request resolves", async () => {
    const queryClient = createQueryClient();
    const cachedEditorData: CatalogEntryWithPermissions = {
      entry: {
        hash,
        filename: "cached.wav",
        hasArchived: true,
        hasMetadata: true,
        isActionable: true,
        isPublished: true,
        hasArchivedAudio: true,
        hasOriginalAudio: true,
      },
      canViewTranscripts: true,
      canEditMetadata: true,
      canDownload: true,
    };

    queryClient.setQueryData(["catalog-entry", hash, groupKey], cachedEditorData);

    let resolveFetch: ((value: CatalogEntryWithPermissions) => void) | undefined;
    fetchJsonMock.mockImplementationOnce(
      () =>
        new Promise<CatalogEntryWithPermissions>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const { result } = renderHook(
      () =>
        useRecordingEntry({
          catalogId,
          hash,
          groupKey,
          enabled: true,
        }),
      { wrapper: createWrapper(queryClient) }
    );

    expect(fetchJsonMock).toHaveBeenCalledWith(
      `/api/catalogs/${catalogId}/recordings/${hash}/entry`,
      expect.objectContaining({
        schema: expect.anything(),
      })
    );
    expect(result.current.data?.canEditMetadata).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isValidatingAccess).toBe(true);

    await act(async () => {
      resolveFetch?.({
        ...cachedEditorData,
        canEditMetadata: false,
      });
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data?.canEditMetadata).toBe(false);
    });
  });

  it("fails closed on cached auth error after the fresh permission check is denied", async () => {
    const queryClient = createQueryClient();
    const cachedEditorData: CatalogEntryWithPermissions = {
      entry: {
        hash,
        filename: "cached.wav",
        hasArchived: true,
        hasMetadata: true,
        isActionable: true,
        isPublished: true,
        hasArchivedAudio: true,
        hasOriginalAudio: true,
      },
      canViewTranscripts: true,
      canEditMetadata: true,
      canDownload: true,
    };

    queryClient.setQueryData(["catalog-entry", hash, groupKey], cachedEditorData);
    fetchJsonMock.mockRejectedValueOnce(new ApiError("Access denied", 403));

    const { result } = renderHook(
      () =>
        useRecordingEntry({
          catalogId,
          hash,
          groupKey,
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

  it("fails closed on cached not-found after the recording becomes hidden", async () => {
    const queryClient = createQueryClient();
    const cachedEditorData: CatalogEntryWithPermissions = {
      entry: {
        hash,
        filename: "cached.wav",
        hasArchived: true,
        hasMetadata: true,
        isActionable: true,
        isPublished: true,
        hasArchivedAudio: true,
        hasOriginalAudio: true,
      },
      canViewTranscripts: true,
      canEditMetadata: true,
      canDownload: true,
    };

    queryClient.setQueryData(["catalog-entry", hash, groupKey], cachedEditorData);
    fetchJsonMock.mockRejectedValueOnce(new ApiError("Recording not found", 404));

    const { result } = renderHook(
      () =>
        useRecordingEntry({
          catalogId,
          hash,
          groupKey,
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

  it("preserves mounted recording permissions while an explicit refetch is in flight", async () => {
    const queryClient = createQueryClient();
    const initialData: CatalogEntryWithPermissions = {
      entry: {
        hash,
        filename: "cached.wav",
        hasArchived: true,
        hasMetadata: true,
        isActionable: true,
        isPublished: true,
        hasArchivedAudio: true,
        hasOriginalAudio: true,
      },
      canViewTranscripts: true,
      canEditMetadata: true,
      canDownload: true,
    };

    let resolveRefetch:
      | ((value: CatalogEntryWithPermissions) => void)
      | undefined;
    fetchJsonMock
      .mockResolvedValueOnce(initialData)
      .mockImplementationOnce(
        () =>
          new Promise<CatalogEntryWithPermissions>((resolve) => {
            resolveRefetch = resolve;
          })
      );

    const { result } = renderHook(
      () =>
        useRecordingEntry({
          catalogId,
          hash,
          groupKey,
          enabled: true,
        }),
      { wrapper: createWrapper(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.data?.canEditMetadata).toBe(true);
    });

    act(() => {
      void result.current.refetch();
    });

    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    });

    expect(result.current.data?.canEditMetadata).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isValidatingAccess).toBe(true);

    await act(async () => {
      resolveRefetch?.({
        ...initialData,
        canEditMetadata: false,
      });
    });

    await waitFor(() => {
      expect(result.current.data?.canEditMetadata).toBe(false);
      expect(result.current.isLoading).toBe(false);
    });
  });
});
