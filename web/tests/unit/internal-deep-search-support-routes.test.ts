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
    workflowGroup: {
      findUnique: vi.fn(),
    },
    audioMetadata: {
      findUnique: vi.fn(),
    },
  },
}));

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

describe("internal deep-search citation and metadata routes", () => {
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

  it("returns citation context and metadata for a valid chunk", async () => {
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({ id: "catalog-1" } as never);
    vi.mocked(prisma.audioMetadata.findUnique).mockResolvedValue({
      workflowGroupId: "catalog-1",
      audioHash: "hash-1",
      dateYear: 1981,
      dateMonth: 6,
      dateDay: 14,
      location: { id: 1, name: "Brno" },
      recorder: { id: 2, name: "Archivist" },
    } as never);

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const endpoint = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (endpoint.endsWith("/resolve")) {
        return jsonResponse({
          colbert_index_dir: process.env.RAG_COLBERT_INDEX_DIR,
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
              after: [
                {
                  chunk_id: "chunk-2",
                  audio_hash: "hash-1",
                  start_sec: 20,
                  end_sec: 30,
                  text: "after",
                },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    const { POST } = await import("@/app/api/internal/deep-search/citation/route");
    const request = new NextRequest("http://localhost/api/internal/deep-search/citation", {
      method: "POST",
      headers: { Authorization: "Bearer test-job-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogId: "catalog-1",
        chunkId: "chunk-1",
        neighborCount: 1,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.catalogId).toBe("catalog-1");
    expect(body.contextText).toBe("before\n\nprimary evidence\n\nafter");
    expect(body.contextStartSec).toBe(0);
    expect(body.contextEndSec).toBe(30);
    expect(body.metadata).toMatchObject({
      location: { id: 1, name: "Brno" },
      recorder: { id: 2, name: "Archivist" },
    });
    expect(body.citation).toMatchObject({
      workflowGroupId: "catalog-1",
      chunkId: "chunk-1",
    });
  });

  it("returns null metadata payload when no curated metadata exists", async () => {
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({ id: "catalog-1" } as never);
    vi.mocked(prisma.audioMetadata.findUnique).mockResolvedValue(null);

    const { POST } = await import("@/app/api/internal/deep-search/metadata/route");
    const request = new NextRequest("http://localhost/api/internal/deep-search/metadata", {
      method: "POST",
      headers: { Authorization: "Bearer test-job-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogId: "catalog-1",
        audioHash: "hash-1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.catalogId).toBe("catalog-1");
    expect(body.audioHash).toBe("hash-1");
    expect(body.metadata).toBeNull();
  });

  it("preserves upstream retrieval errors for citation lookups", async () => {
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({ id: "catalog-1" } as never);

    fetchMock.mockImplementation(async (url: string | URL) => {
      const endpoint = String(url);

      if (endpoint.endsWith("/resolve")) {
        return jsonResponse({
          colbert_index_dir: process.env.RAG_COLBERT_INDEX_DIR,
        });
      }
      if (endpoint.endsWith("/lookup")) {
        return jsonResponse({
          invalid: [],
        });
      }
      if (endpoint.endsWith("/neighbors")) {
        return jsonResponse({
          neighbors: {},
        });
      }
      throw new Error(`Unexpected fetch endpoint: ${endpoint}`);
    });

    const { POST } = await import("@/app/api/internal/deep-search/citation/route");
    const request = new NextRequest("http://localhost/api/internal/deep-search/citation", {
      method: "POST",
      headers: { Authorization: "Bearer test-job-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogId: "catalog-1",
        chunkId: "chunk-1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("Invalid ColBERT lookup payload");
  });
});
