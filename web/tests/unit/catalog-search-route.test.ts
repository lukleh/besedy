import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as searchCatalog } from "@/app/api/catalogs/[id]/search/route";
import prisma from "@/lib/db";

const originalEnv = process.env;

vi.mock("@/lib/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/permissions")>();
  return {
    ...actual,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  getRagBackendKey: vi.fn(() => "faster-whisper/large-v3@silero_vad_v6"),
  getRagColbertModel: vi.fn(() => "jinaai/jina-colbert-v2"),
  getRagRerankModel: vi.fn(() => "Alibaba-NLP/gte-multilingual-reranker-base"),
  RAG_DEFAULTS: {
    RESULT_LIMIT: 10,
    MAX_LIMIT: 100,
    RERANK_TOP_N: 10,
    RELATIVE_SCORE_CUTOFF: 0.8,
    TIMEOUT_MS: 5000,
    RERANK_URL: "http://localhost:9000/rerank",
    RERANK_MODEL: "Alibaba-NLP/gte-multilingual-reranker-base",
    COLBERT_URL: "http://localhost:8192/query",
    COLBERT_TOP_K: 200,
    COLBERT_MODEL: "jinaai/jina-colbert-v2",
    COLBERT_ROOT_DIR: "/workspace/besedy/tmp/rag_colbert",
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    $queryRaw: vi.fn(),
    audioMetadata: {
      findMany: vi.fn(),
    },
  },
}));

function sqlText(query: unknown): string {
  const strings = (query as { strings?: ReadonlyArray<string> }).strings;
  return strings ? strings.join(" ? ") : String(query);
}

function sqlValues(query: unknown): unknown[] {
  return ((query as { values?: unknown[] }).values ?? []).slice();
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
  };
}

describe("catalog search route", () => {
  const catalogId = "20260201_120000";

  let requireAuth: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.RAG_COLBERT_INDEX_DIR = "/workspace/besedy/tmp/rag-colbert-test/index/colbert_index";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
    getCatalogCapability = (
      await import("@/lib/access/capabilities")
    ).getCatalogCapability as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 404 before 403 when the catalog is missing", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: false,
      hasAccess: false,
      canUseRagSearch: false,
    });

    const response = await searchCatalog(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "folk song" }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(404);
  });

  it("returns 403 when the user cannot access the catalog", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: false,
      canUseRagSearch: false,
    });

    const response = await searchCatalog(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "folk song" }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(403);
  });

  it("returns 403 when RAG search is not enabled for the capability", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canUseRagSearch: false,
    });

    const response = await searchCatalog(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "folk song" }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(403);
  });

  it("supports ColBERT retrieval mode while preserving the response contract", async () => {
    const queryRawMock = vi.mocked(prisma.$queryRaw);
    const metadataFindManyMock = vi.mocked(prisma.audioMetadata.findMany);

    process.env.RAG_COLBERT_RERANK_ENABLED = "true";

    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canUseRagSearch: true,
      accessLevel: "LISTENER",
    });

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const endpoint = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (endpoint.endsWith("/resolve")) {
        return jsonResponse({
          colbert_index_dir: process.env.RAG_COLBERT_INDEX_DIR,
        });
      }

      if (endpoint.endsWith("/query")) {
        return jsonResponse({
          hits: [
            { document_id: "chunk-2", score: 19.3 },
            { chunk_id: "chunk-3", score: 18.1 },
            { chunk_id: "chunk-hidden", score: 17.2 },
          ],
        });
      }

      if (endpoint.endsWith("/lookup")) {
        expect(body.chunk_ids).toEqual(["chunk-2", "chunk-3", "chunk-hidden"]);
        return jsonResponse({
          chunks: [
            {
              chunk_id: "chunk-2",
              audio_hash: "hash-1",
              start_sec: 10,
              end_sec: 20,
              text: "primary evidence",
              run_id: "run-123",
              chunk_version: "v2",
            },
            {
              chunk_id: "chunk-3",
              audio_hash: "hash-2",
              start_sec: 30,
              end_sec: 40,
              text: "secondary evidence",
              run_id: "run-123",
              chunk_version: "v2",
            },
            {
              chunk_id: "chunk-hidden",
              audio_hash: "hash-hidden",
              start_sec: 50,
              end_sec: 60,
              text: "hidden evidence",
              run_id: "run-123",
              chunk_version: "v2",
            },
          ],
        });
      }

      if (endpoint.endsWith("/neighbors")) {
        return jsonResponse({
          neighbors: {
            "chunk-2": {
              before: [
                {
                  chunk_id: "chunk-1",
                  audio_hash: "hash-1",
                  start_sec: 0,
                  end_sec: 10,
                  text: "leading context",
                },
              ],
              after: [],
            },
          },
        });
      }

      if (endpoint.endsWith("/rerank")) {
        return jsonResponse([
          { index: 0, score: 0.91 },
          { index: 1, score: 0.76 },
        ]);
      }

      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    queryRawMock.mockImplementation((((query: unknown) => {
      const text = sqlText(query);
      if (text.includes("FROM catalog_entry ce")) {
        return Promise.resolve([
          { audioHash: "hash-1" },
          { audioHash: "hash-2" },
        ]);
      }

      return Promise.resolve([]);
    }) as never));

    metadataFindManyMock.mockResolvedValue([
      {
        audioHash: "hash-1",
        dateYear: 1975,
        dateMonth: 3,
        dateDay: 15,
        location: { id: 7, name: "Brno" },
        recorder: { id: 8, name: "Archiv" },
      },
      {
        audioHash: "hash-2",
        dateYear: null,
        dateMonth: null,
        dateDay: null,
        location: null,
        recorder: null,
      },
    ] as never);

    const response = await searchCatalog(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "folk song",
          includeNeighbors: true,
          neighborCount: 1,
        }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);

    const colbertRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"));
    expect(colbertRequest).toMatchObject({
      query: "folk song",
      k: 200,
      force_fast: false,
      colbert_index_dir: "/workspace/besedy/tmp/rag-colbert-test/index/colbert_index",
    });

    const payload = await response.json();
    expect(payload).toEqual({
      query: "folk song",
      results: [
        {
          rank: 1,
          audioHash: "hash-1",
          chunkId: "chunk-2",
          score: 0.91,
          startSec: 10,
          endSec: 20,
          text: "primary evidence",
          contextText: "leading context\n\nprimary evidence",
          contextStartSec: 0,
          contextEndSec: 20,
          neighbors: {
            before: [
              {
                chunkId: "chunk-1",
                audioHash: "hash-1",
                startSec: 0,
                endSec: 10,
                text: "leading context",
              },
            ],
            after: [],
          },
          metadata: {
            date: {
              year: 1975,
              month: 3,
              day: 15,
            },
            location: { id: 7, name: "Brno" },
            recorder: { id: 8, name: "Archiv" },
          },
          citation: {
            audioHash: "hash-1",
            chunkId: "chunk-2",
            startSec: 10,
            endSec: 20,
            workflowGroupId: catalogId,
            backendKey: "faster-whisper/large-v3@silero_vad_v6",
            chunkVersion: "v2",
          },
          provenance: {
            workflowGroupId: catalogId,
            backendKey: "faster-whisper/large-v3@silero_vad_v6",
            runId: "run-123",
            chunkVersion: "v2",
            embeddingModel: "jinaai/jina-colbert-v2",
            embeddingModelVersion: "",
          },
        },
        {
          rank: 2,
          audioHash: "hash-2",
          chunkId: "chunk-3",
          score: 0.76,
          startSec: 30,
          endSec: 40,
          text: "secondary evidence",
          contextText: "secondary evidence",
          contextStartSec: 30,
          contextEndSec: 40,
          neighbors: {
            before: [],
            after: [],
          },
          metadata: {
            date: {
              year: null,
              month: null,
              day: null,
            },
            location: null,
            recorder: null,
          },
          citation: {
            audioHash: "hash-2",
            chunkId: "chunk-3",
            startSec: 30,
            endSec: 40,
            workflowGroupId: catalogId,
            backendKey: "faster-whisper/large-v3@silero_vad_v6",
            chunkVersion: "v2",
          },
          provenance: {
            workflowGroupId: catalogId,
            backendKey: "faster-whisper/large-v3@silero_vad_v6",
            runId: "run-123",
            chunkVersion: "v2",
            embeddingModel: "jinaai/jina-colbert-v2",
            embeddingModelVersion: "",
          },
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const sqlCalls = queryRawMock.mock.calls.map(([query]) => sqlText(query));
    expect(sqlCalls[0]).toContain("FROM catalog_entry ce");
    expect(sqlCalls[0]).toContain("ce.is_actionable = true");
    expect(sqlCalls[0]).toContain("ce.is_published = true");
  });

  it("fetches deeper ColBERT hits when listener filtering removes the first batch", async () => {
    const queryRawMock = vi.mocked(prisma.$queryRaw);
    const metadataFindManyMock = vi.mocked(prisma.audioMetadata.findMany);

    process.env.RAG_COLBERT_RERANK_ENABLED = "true";

    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canUseRagSearch: true,
      accessLevel: "LISTENER",
    });

    const firstBatchHits = Array.from({ length: 200 }, (_, index) => ({
      chunk_id: index === 0 ? "chunk-visible-1" : `chunk-hidden-${index}`,
      score: 25 - index * 0.01,
    }));
    const secondBatchHits = [
      ...firstBatchHits,
      { chunk_id: "chunk-visible-2", score: 22.5 },
      ...Array.from({ length: 199 }, (_, index) => ({
        chunk_id: `chunk-hidden-deep-${index}`,
        score: 22.49 - index * 0.01,
      })),
    ];

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const endpoint = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (endpoint.endsWith("/resolve")) {
        return jsonResponse({
          colbert_index_dir: process.env.RAG_COLBERT_INDEX_DIR,
        });
      }

      if (endpoint.endsWith("/query")) {
        return jsonResponse({ hits: body.k === 200 ? firstBatchHits : secondBatchHits });
      }

      if (endpoint.endsWith("/lookup")) {
        const chunkIds = body.chunk_ids as string[];
        const chunks = [
          {
            chunk_id: "chunk-visible-1",
            audio_hash: "hash-1",
            start_sec: 10,
            end_sec: 20,
            text: "primary evidence",
            run_id: "run-123",
            chunk_version: "v2",
          },
        ];
        if (chunkIds.includes("chunk-visible-2")) {
          chunks.push({
            chunk_id: "chunk-visible-2",
            audio_hash: "hash-2",
            start_sec: 30,
            end_sec: 40,
            text: "secondary evidence",
            run_id: "run-123",
            chunk_version: "v2",
          });
        }
        return jsonResponse({ chunks });
      }

      if (endpoint.endsWith("/rerank")) {
        return jsonResponse([
          { index: 0, score: 0.92 },
          { index: 1, score: 0.81 },
        ]);
      }

      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    queryRawMock.mockImplementation((((query: unknown) => {
      const text = sqlText(query);
      if (text.includes("FROM catalog_entry ce")) {
        const values = sqlValues(query);
        const includesSecondVisibleChunk = values.includes("hash-2");
        return Promise.resolve(
          includesSecondVisibleChunk
            ? [{ audioHash: "hash-1" }, { audioHash: "hash-2" }]
            : [{ audioHash: "hash-1" }],
        );
      }

      return Promise.resolve([]);
    }) as never));

    metadataFindManyMock.mockResolvedValue([
      {
        audioHash: "hash-1",
        dateYear: 1975,
        dateMonth: 3,
        dateDay: 15,
        location: { id: 7, name: "Brno" },
        recorder: { id: 8, name: "Archiv" },
      },
      {
        audioHash: "hash-2",
        dateYear: 1976,
        dateMonth: 4,
        dateDay: 16,
        location: { id: 9, name: "Praha" },
        recorder: { id: 10, name: "Studio" },
      },
    ] as never);

    const response = await searchCatalog(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "folk song",
          limit: 2,
          candidateLimit: 2,
        }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const firstColbertRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"));
    const secondColbertRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body ?? "{}"));
    expect(firstColbertRequest.k).toBe(200);
    expect(secondColbertRequest.k).toBe(400);

    const payload = await response.json();
    expect(payload.results).toHaveLength(2);
    expect(payload.results.map((result: { chunkId: string }) => result.chunkId)).toEqual([
      "chunk-visible-1",
      "chunk-visible-2",
    ]);
  });

  it("uses raw ColBERT scores when ColBERT reranking is disabled", async () => {
    const queryRawMock = vi.mocked(prisma.$queryRaw);
    const metadataFindManyMock = vi.mocked(prisma.audioMetadata.findMany);

    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canUseRagSearch: true,
      accessLevel: "VIEWER",
    });

    fetchMock.mockImplementation(async (url: string | URL) => {
      const endpoint = String(url);
      if (endpoint.endsWith("/resolve")) {
        return jsonResponse({
          colbert_index_dir: process.env.RAG_COLBERT_INDEX_DIR,
        });
      }
      if (endpoint.endsWith("/query")) {
        return jsonResponse({
          hits: [
            { chunk_id: "chunk-2", score: 19.3 },
            { chunk_id: "chunk-3", score: 18.1 },
          ],
        });
      }
      if (endpoint.endsWith("/lookup")) {
        return jsonResponse({
          chunks: [
            {
              chunk_id: "chunk-2",
              audio_hash: "hash-1",
              start_sec: 10,
              end_sec: 20,
              text: "primary evidence",
              run_id: "run-123",
              chunk_version: "v2",
            },
            {
              chunk_id: "chunk-3",
              audio_hash: "hash-2",
              start_sec: 30,
              end_sec: 40,
              text: "secondary evidence",
              run_id: "run-123",
              chunk_version: "v2",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    queryRawMock.mockImplementation((((query: unknown) => {
      const text = sqlText(query);
      if (text.includes("FROM catalog_entry ce")) {
        return Promise.resolve([{ audioHash: "hash-1" }, { audioHash: "hash-2" }]);
      }

      return Promise.resolve([]);
    }) as never));

    metadataFindManyMock.mockResolvedValue([
      {
        audioHash: "hash-1",
        dateYear: 1975,
        dateMonth: 3,
        dateDay: 15,
        location: null,
        recorder: null,
      },
      {
        audioHash: "hash-2",
        dateYear: null,
        dateMonth: null,
        dateDay: null,
        location: null,
        recorder: null,
      },
    ] as never);

    const response = await searchCatalog(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "folk song" }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const payload = await response.json();
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0]).toMatchObject({
      chunkId: "chunk-2",
      score: 19.3,
    });
    expect(payload.results[1]).toMatchObject({
      chunkId: "chunk-3",
      score: 18.1,
    });
  });

  it("does not let a low rerank budget underfill filtered ColBERT results when reranking is disabled", async () => {
    const queryRawMock = vi.mocked(prisma.$queryRaw);
    const metadataFindManyMock = vi.mocked(prisma.audioMetadata.findMany);

    process.env.RAG_RERANK_TOP_N = "2";
    process.env.RAG_COLBERT_RERANK_ENABLED = "false";

    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canUseRagSearch: true,
      accessLevel: "LISTENER",
    });

    const firstBatchHits = Array.from({ length: 200 }, (_, index) => ({
      chunk_id:
        index === 0 ? "chunk-visible-1" : index === 1 ? "chunk-visible-2" : `chunk-hidden-${index}`,
      score: 25 - index * 0.01,
    }));
    const secondBatchHits = [
      ...firstBatchHits,
      { chunk_id: "chunk-visible-3", score: 22.5 },
      ...Array.from({ length: 199 }, (_, index) => ({
        chunk_id: `chunk-hidden-deep-${index}`,
        score: 22.49 - index * 0.01,
      })),
    ];

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const endpoint = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (endpoint.endsWith("/resolve")) {
        return jsonResponse({
          colbert_index_dir: process.env.RAG_COLBERT_INDEX_DIR,
        });
      }

      if (endpoint.endsWith("/query")) {
        return jsonResponse({ hits: body.k === 200 ? firstBatchHits : secondBatchHits });
      }

      if (endpoint.endsWith("/lookup")) {
        const chunkIds = body.chunk_ids as string[];
        const chunks = [
          {
            chunk_id: "chunk-visible-1",
            audio_hash: "hash-1",
            start_sec: 10,
            end_sec: 20,
            text: "primary evidence",
            run_id: "run-123",
            chunk_version: "v2",
          },
          {
            chunk_id: "chunk-visible-2",
            audio_hash: "hash-2",
            start_sec: 30,
            end_sec: 40,
            text: "secondary evidence",
            run_id: "run-123",
            chunk_version: "v2",
          },
        ];
        if (chunkIds.includes("chunk-visible-3")) {
          chunks.push({
            chunk_id: "chunk-visible-3",
            audio_hash: "hash-3",
            start_sec: 50,
            end_sec: 60,
            text: "third evidence",
            run_id: "run-123",
            chunk_version: "v2",
          });
        }
        return jsonResponse({ chunks });
      }

      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    queryRawMock.mockImplementation((((query: unknown) => {
      const text = sqlText(query);
      if (text.includes("FROM catalog_entry ce")) {
        const values = sqlValues(query);
        const includesThirdVisibleChunk = values.includes("hash-3");
        return Promise.resolve(
          includesThirdVisibleChunk
            ? [{ audioHash: "hash-1" }, { audioHash: "hash-2" }, { audioHash: "hash-3" }]
            : [{ audioHash: "hash-1" }, { audioHash: "hash-2" }],
        );
      }

      return Promise.resolve([]);
    }) as never));

    metadataFindManyMock.mockResolvedValue([
      {
        audioHash: "hash-1",
        dateYear: 1975,
        dateMonth: 3,
        dateDay: 15,
        location: null,
        recorder: null,
      },
      {
        audioHash: "hash-2",
        dateYear: 1976,
        dateMonth: 4,
        dateDay: 16,
        location: null,
        recorder: null,
      },
      {
        audioHash: "hash-3",
        dateYear: 1977,
        dateMonth: 5,
        dateDay: 17,
        location: null,
        recorder: null,
      },
    ] as never);

    const response = await searchCatalog(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "folk song",
          limit: 3,
        }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const firstColbertRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"));
    const secondColbertRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body ?? "{}"));
    expect(firstColbertRequest.k).toBe(200);
    expect(secondColbertRequest.k).toBe(400);

    const payload = await response.json();
    expect(payload.results).toHaveLength(3);
    expect(payload.results.map((result: { chunkId: string }) => result.chunkId)).toEqual([
      "chunk-visible-1",
      "chunk-visible-2",
      "chunk-visible-3",
    ]);
  });

  it("caps client candidateLimit at the server rerank budget", async () => {
    const queryRawMock = vi.mocked(prisma.$queryRaw);
    const metadataFindManyMock = vi.mocked(prisma.audioMetadata.findMany);

    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canUseRagSearch: true,
      accessLevel: "VIEWER",
    });
    process.env.RAG_COLBERT_RERANK_ENABLED = "true";

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const endpoint = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (endpoint.endsWith("/resolve")) {
        return jsonResponse({
          colbert_index_dir: process.env.RAG_COLBERT_INDEX_DIR,
        });
      }

      if (endpoint.endsWith("/query")) {
        return jsonResponse({
          hits: Array.from({ length: 20 }, (_, index) => ({
            chunk_id: `chunk-${index + 1}`,
            score: 1 - index * 0.01,
          })),
        });
      }

      if (endpoint.endsWith("/lookup")) {
        return jsonResponse({
          chunks: Array.from({ length: 20 }, (_, index) => ({
            chunk_id: `chunk-${index + 1}`,
            audio_hash: `hash-${index + 1}`,
            start_sec: index * 10,
            end_sec: index * 10 + 10,
            text: `evidence ${index + 1}`,
            run_id: "run-123",
            chunk_version: "v2",
          })),
        });
      }

      if (endpoint.endsWith("/rerank")) {
        return jsonResponse(
          body.texts.map((_: string, index: number) => ({
            index,
            score: 1 - index * 0.01,
          })),
        );
      }

      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    queryRawMock.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => ({ audioHash: `hash-${index + 1}` })) as never,
    );

    metadataFindManyMock.mockResolvedValue([] as never);

    const response = await searchCatalog(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "folk song",
          limit: 3,
          candidateLimit: 200,
        }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);

    const rerankRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body ?? "{}"));
    expect(rerankRequest.texts).toHaveLength(10);

    const payload = await response.json();
    expect(payload.results).toHaveLength(3);
  });

  it("fills deduped result slots from deeper fused candidates before reranking", async () => {
    const queryRawMock = vi.mocked(prisma.$queryRaw);
    const metadataFindManyMock = vi.mocked(prisma.audioMetadata.findMany);

    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canUseRagSearch: true,
      accessLevel: "VIEWER",
    });
    process.env.RAG_COLBERT_RERANK_ENABLED = "true";

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const endpoint = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (endpoint.endsWith("/resolve")) {
        return jsonResponse({
          colbert_index_dir: process.env.RAG_COLBERT_INDEX_DIR,
        });
      }

      if (endpoint.endsWith("/query")) {
        return jsonResponse({
          hits: [
            { chunk_id: "chunk-a1", score: 0.95 },
            { chunk_id: "chunk-a2", score: 0.9 },
            { chunk_id: "chunk-a3", score: 0.85 },
            { chunk_id: "chunk-b1", score: 0.8 },
          ],
        });
      }

      if (endpoint.endsWith("/lookup")) {
        return jsonResponse({
          chunks: [
            {
              chunk_id: "chunk-a1",
              audio_hash: "audio-a",
              start_sec: 0,
              end_sec: 10,
              text: "audio-a first",
              run_id: "run-123",
              chunk_version: "v2",
            },
            {
              chunk_id: "chunk-a2",
              audio_hash: "audio-a",
              start_sec: 10,
              end_sec: 20,
              text: "audio-a second",
              run_id: "run-123",
              chunk_version: "v2",
            },
            {
              chunk_id: "chunk-a3",
              audio_hash: "audio-a",
              start_sec: 20,
              end_sec: 30,
              text: "audio-a third",
              run_id: "run-123",
              chunk_version: "v2",
            },
            {
              chunk_id: "chunk-b1",
              audio_hash: "audio-b",
              start_sec: 0,
              end_sec: 10,
              text: "audio-b first",
              run_id: "run-123",
              chunk_version: "v2",
            },
          ],
        });
      }

      if (endpoint.endsWith("/rerank")) {
        return jsonResponse(
          body.texts.map((_: string, index: number) => ({
            index,
            score: 1 - index * 0.01,
          })),
        );
      }

      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    queryRawMock.mockResolvedValue([{ audioHash: "audio-a" }, { audioHash: "audio-b" }] as never);

    metadataFindManyMock.mockResolvedValue([] as never);

    const response = await searchCatalog(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "folk song",
          limit: 2,
          candidateLimit: 2,
          dedupeByAudio: true,
        }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);

    const rerankRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body ?? "{}"));
    expect(rerankRequest.texts).toEqual(["audio-a first", "audio-b first"]);

    const payload = await response.json();
    expect(payload.results.map((item: { audioHash: string }) => item.audioHash)).toEqual([
      "audio-a",
      "audio-b",
    ]);
  });
});
