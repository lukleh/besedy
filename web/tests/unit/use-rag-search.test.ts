import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRagSearch } from "@/components/catalog/catalog-list/hooks/use-rag-search";
import { fetchJson } from "@/lib/api/fetch-json";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/api/fetch-json", () => {
  class MockApiError extends Error {}
  return {
    fetchJson: vi.fn(),
    ApiError: MockApiError,
  };
});

describe("useRagSearch", () => {
  const fetchJsonMock = vi.mocked(fetchJson);

  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it("preserves restored RAG state on initial render with cached catalog data", async () => {
    const activeCatalogId = "catalog-1";
    const savedQuery = "restore me";

    window.sessionStorage.setItem(
      `besedy-rag-search-${activeCatalogId}`,
      JSON.stringify({ query: savedQuery }),
    );

    fetchJsonMock.mockResolvedValue({
      query: savedQuery,
      results: [
        {
          rank: 1,
          audioHash: "hash-1",
          chunkId: "chunk-1",
          score: 0.93,
          startSec: 1,
          endSec: 3,
          text: "Test snippet",
          contextText: "Test snippet",
          contextStartSec: 1,
          contextEndSec: 3,
          neighbors: { before: [], after: [] },
          metadata: {
            date: { year: null, month: null, day: null },
            location: null,
            recorder: null,
          },
          citation: {
            audioHash: "hash-1",
            chunkId: "chunk-1",
            startSec: 1,
            endSec: 3,
            workflowGroupId: activeCatalogId,
            backendKey: "backend-1",
            chunkVersion: "v2",
          },
          provenance: {
            workflowGroupId: activeCatalogId,
            backendKey: "backend-1",
            runId: "run-1",
            chunkVersion: "v2",
            embeddingModel: "model-1",
            embeddingModelVersion: "1",
          },
        },
      ],
    });

    const { result } = renderHook(() =>
      useRagSearch({
        activeCatalogId,
        canUseRagSearch: true,
        dataLoaded: true,
      }),
    );

    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchJsonMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/catalogs/${activeCatalogId}/search`);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: savedQuery,
    });

    await waitFor(() => {
      expect(result.current.ragQuery).toBe(savedQuery);
      expect(result.current.ragSubmittedQuery).toBe(savedQuery);
      expect(result.current.isRagMode).toBe(true);
      expect(result.current.ragResults).toHaveLength(1);
      expect(result.current.ragLoading).toBe(false);
    });
  });

  it("hides RAG mode without clearing query or results", async () => {
    const activeCatalogId = "catalog-2";
    const query = "existing results";

    fetchJsonMock.mockResolvedValue({
      query,
      results: [
        {
          rank: 1,
          audioHash: "hash-2",
          chunkId: "chunk-2",
          score: 0.91,
          startSec: 12,
          endSec: 18,
          text: "Another snippet",
          contextText: "Another snippet",
          contextStartSec: 12,
          contextEndSec: 18,
          neighbors: { before: [], after: [] },
          metadata: {
            date: { year: null, month: null, day: null },
            location: null,
            recorder: null,
          },
          citation: {
            audioHash: "hash-2",
            chunkId: "chunk-2",
            startSec: 12,
            endSec: 18,
            workflowGroupId: activeCatalogId,
            backendKey: "backend-1",
            chunkVersion: "v2",
          },
          provenance: {
            workflowGroupId: activeCatalogId,
            backendKey: "backend-1",
            runId: "run-1",
            chunkVersion: "v2",
            embeddingModel: "model-1",
            embeddingModelVersion: "1",
          },
        },
      ],
    });

    const { result } = renderHook(() =>
      useRagSearch({
        activeCatalogId,
        canUseRagSearch: true,
        dataLoaded: true,
      }),
    );

    act(() => {
      result.current.setRagQuery(query);
    });

    await act(async () => {
      await result.current.executeRagSearch(query);
    });

    await waitFor(() => {
      expect(result.current.isRagMode).toBe(true);
      expect(result.current.ragSubmittedQuery).toBe(query);
      expect(result.current.ragResults).toHaveLength(1);
    });

    act(() => {
      result.current.hideRagMode();
    });

    expect(result.current.isRagMode).toBe(false);
    expect(result.current.ragQuery).toBe(query);
    expect(result.current.ragSubmittedQuery).toBe(query);
    expect(result.current.ragResults).toHaveLength(1);
    expect(
      window.sessionStorage.getItem(`besedy-rag-search-${activeCatalogId}`),
    ).toBe(JSON.stringify({ query }));
  });

  it("uses a scoped session key when provided", async () => {
    const activeCatalogId = "catalog-3";
    const scopedQuery = "event query";

    window.sessionStorage.setItem(
      `besedy-rag-search-${activeCatalogId}`,
      JSON.stringify({ query: "recordings query" }),
    );
    window.sessionStorage.setItem(
      `besedy-rag-search-${activeCatalogId}-events`,
      JSON.stringify({ query: scopedQuery }),
    );

    fetchJsonMock.mockResolvedValue({
      query: scopedQuery,
      results: [],
    });

    const { result } = renderHook(() =>
      useRagSearch({
        activeCatalogId,
        canUseRagSearch: true,
        sessionScope: "events",
        dataLoaded: true,
      }),
    );

    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    });

    expect(
      JSON.parse(String(fetchJsonMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      query: scopedQuery,
    });
    expect(result.current.ragQuery).toBe(scopedQuery);
  });

  it("logs a warning and skips restore when session state is malformed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const activeCatalogId = "catalog-bad";

    window.sessionStorage.setItem(
      `besedy-rag-search-${activeCatalogId}`,
      "{",
    );

    renderHook(() =>
      useRagSearch({
        activeCatalogId,
        canUseRagSearch: true,
        dataLoaded: true,
      }),
    );

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "Ignoring malformed RAG session state",
        expect.objectContaining({
          sessionKey: `besedy-rag-search-${activeCatalogId}`,
        }),
      );
    });
    expect(fetchJsonMock).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
