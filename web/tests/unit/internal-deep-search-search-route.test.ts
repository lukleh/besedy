import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const originalEnv = process.env;

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
    workflowGroup: {
      findUnique: vi.fn(),
    },
    audioMetadata: {
      findMany: vi.fn(),
    },
  },
}));

function sqlText(query: unknown): string {
  const strings = (query as { strings?: ReadonlyArray<string> }).strings;
  return strings ? strings.join(" ? ") : String(query);
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

describe("internal deep-search search route", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.BESEDY_JOB_SERVICE_SECRET = "test-job-secret";
    process.env.RAG_COLBERT_INDEX_DIR = "/workspace/besedy/tmp/rag-colbert-test/index/colbert_index";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("returns 401 when the jobs-service secret is missing", async () => {
    delete process.env.BESEDY_JOB_SERVICE_SECRET;
    vi.resetModules();

    const { POST } = await import("@/app/api/internal/deep-search/search/route");
    const request = new NextRequest("http://localhost/api/internal/deep-search/search", {
      method: "POST",
      headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
      body: JSON.stringify({ catalogId: "catalog-1", query: "brno" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 401 when the bearer token is wrong (secret set)", async () => {
    // Secret is set in beforeEach; a wrong token must be rejected by the
    // constant-time comparison in authorizeDeepSearchServiceRequest.
    const { POST } = await import("@/app/api/internal/deep-search/search/route");
    const request = new NextRequest("http://localhost/api/internal/deep-search/search", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ catalogId: "catalog-1", query: "brno" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 404 when the catalog does not exist", async () => {
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue(null);

    const { POST } = await import("@/app/api/internal/deep-search/search/route");
    const request = new NextRequest("http://localhost/api/internal/deep-search/search", {
      method: "POST",
      headers: { Authorization: "Bearer test-job-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ catalogId: "catalog-1", query: "brno" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(404);
  });

  it("returns 404 when the catalog has no resolved ColBERT bundle", async () => {
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({ id: "catalog-1" } as never);

    fetchMock.mockImplementation(async (url: string | URL) => {
      const endpoint = String(url);
      if (endpoint.endsWith("/resolve")) {
        return {
          ok: false,
          status: 404,
          text: async () => "not found",
        };
      }
      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    const { POST } = await import("@/app/api/internal/deep-search/search/route");
    const request = new NextRequest("http://localhost/api/internal/deep-search/search", {
      method: "POST",
      headers: { Authorization: "Bearer test-job-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ catalogId: "catalog-1", query: "brno" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("ColBERT bundle not found for catalog");
  });

  it("returns search results for a valid internal request", async () => {
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({ id: "catalog-1" } as never);
    vi.mocked(prisma.$queryRaw).mockImplementation((((query: unknown) => {
      const text = sqlText(query);
      if (text.includes("FROM catalog_entry ce")) {
        return Promise.resolve([{ audioHash: "hash-1" }]);
      }
      return Promise.resolve([]);
    }) as never));
    vi.mocked(prisma.audioMetadata.findMany).mockResolvedValue([
      {
        audioHash: "hash-1",
        dateYear: 1981,
        dateMonth: 6,
        dateDay: 14,
        location: { id: 1, name: "Brno" },
        recorder: { id: 2, name: "Archivist" },
      },
    ] as never);

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
          hits: [{ chunk_id: "chunk-1", score: 9.5 }],
        });
      }

      if (endpoint.endsWith("/lookup")) {
        expect(body.chunk_ids).toEqual(["chunk-1"]);
        return jsonResponse({
          chunks: [
            {
              chunk_id: "chunk-1",
              audio_hash: "hash-1",
              start_sec: 10,
              end_sec: 20,
              text: "primary evidence",
              run_id: "run-123",
              chunk_version: "v2",
            },
          ],
        });
      }

      if (endpoint.endsWith("/neighbors")) {
        return jsonResponse({
          neighbors: {
            "chunk-1": {
              before: [
                {
                  chunk_id: "chunk-0",
                  audio_hash: "hash-1",
                  start_sec: 0,
                  end_sec: 10,
                  text: "before",
                },
              ],
              after: [],
            },
          },
        });
      }

      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    const { POST } = await import("@/app/api/internal/deep-search/search/route");
    const request = new NextRequest("http://localhost/api/internal/deep-search/search", {
      method: "POST",
      headers: { Authorization: "Bearer test-job-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogId: "catalog-1",
        query: "who mentions Brno?",
        includeNeighbors: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.catalogId).toBe("catalog-1");
    expect(body.query).toBe("who mentions Brno?");
    expect(body.retrieval).toMatchObject({
      backendKey: "faster-whisper/large-v3@silero_vad_v6",
      retrievalMode: "colbert",
      fusedCandidates: 1,
    });
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      chunkId: "chunk-1",
      audioHash: "hash-1",
      text: "primary evidence",
      contextText: "before\n\nprimary evidence",
      metadata: {
        location: { id: 1, name: "Brno" },
        recorder: { id: 2, name: "Archivist" },
      },
      citation: {
        workflowGroupId: "catalog-1",
      },
    });
    expect(body.timings.totalMs).toBeGreaterThanOrEqual(0);
  });
});
