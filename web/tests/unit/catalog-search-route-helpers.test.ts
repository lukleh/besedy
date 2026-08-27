import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PER_AUDIO_LIMIT,
  SearchRequestSchema,
  applyMaxPerAudio,
  assembleContextText,
  collectRerankCandidates,
  getSearchConfig,
  resolveColbertFetchLimit,
  resolveColbertIndexDir,
  resolveRerankCandidateLimit,
  shouldOverfetchColbertResults,
} from "@/app/api/catalogs/[id]/search/search-route-helpers";

const originalEnv = process.env;

function makeCandidate(chunkId: string, audioHash: string, rerankScore: number) {
  return {
    chunkId,
    audioHash,
    startSec: 0,
    endSec: 10,
    text: chunkId,
    runId: "run-1",
    chunkVersion: "v2",
    embeddingModel: "model-1",
    embeddingModelVersion: "1",
    denseRank: 1,
    sparseRank: 1,
    denseScore: rerankScore,
    sparseScore: rerankScore,
    rrfScore: rerankScore,
    rerankScore,
  };
}

describe("catalog search route helpers", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("fails loudly on invalid numeric config", () => {
    process.env.RAG_RERANK_TOP_N = "zero";
    expect(() => getSearchConfig()).toThrow(/RAG_RERANK_TOP_N must be a positive integer/);
  });

  it("allows max-per-audio searches up to the overall result ceiling", () => {
    expect(MAX_PER_AUDIO_LIMIT).toBe(100);
    expect(SearchRequestSchema.safeParse({ query: "topic", maxPerAudio: 100 }).success).toBe(true);
    expect(SearchRequestSchema.safeParse({ query: "topic", maxPerAudio: 101 }).success).toBe(false);
  });

  it("prefers the legacy TEI rerank URL and exposes the rerank model", () => {
    process.env.RAG_TEI_RERANK_URL = "http://localhost:8191/rerank";
    process.env.RAG_RERANK_URL = "http://localhost:9191/v1/rerank";
    process.env.RAG_RERANK_MODEL = "custom/reranker";

    expect(getSearchConfig()).toMatchObject({
      rerankUrl: "http://localhost:8191/rerank",
      rerankModel: "custom/reranker",
    });
  });

  it("falls back to RAG_RERANK_URL when the TEI-specific alias is unset", () => {
    delete process.env.RAG_TEI_RERANK_URL;
    process.env.RAG_RERANK_URL = "http://localhost:9191/v1/rerank";

    expect(getSearchConfig().rerankUrl).toBe("http://localhost:9191/v1/rerank");
  });

  it("exposes ColBERT runtime config", () => {
    process.env.RAG_COLBERT_URL = "http://localhost:8192/query";
    process.env.RAG_COLBERT_TOP_K = "250";
    process.env.RAG_COLBERT_MODEL = "jinaai/jina-colbert-v2";
    process.env.RAG_COLBERT_ROOT_DIR = "/workspace/besedy/tmp/rag_colbert";

    expect(getSearchConfig()).toMatchObject({
      retrievalMode: "colbert",
      rerankEnabled: false,
      colbertUrl: "http://localhost:8192/query",
      colbertTopK: 250,
      colbertModel: "jinaai/jina-colbert-v2",
      colbertRootDir: "/workspace/besedy/tmp/rag_colbert",
    });
  });

  it("allows ColBERT reranking to be explicitly re-enabled", () => {
    process.env.RAG_COLBERT_RERANK_ENABLED = "true";

    expect(getSearchConfig().rerankEnabled).toBe(true);
  });

  it("caps rerank candidate selection at the server rerank budget", () => {
    expect(resolveRerankCandidateLimit(200, 5, 10)).toBe(10);
    expect(resolveRerankCandidateLimit(undefined, 5, 10)).toBe(10);
    expect(resolveRerankCandidateLimit(3, 5, 10)).toBe(5);
  });

  it("overfetches ColBERT when results will be post-filtered", () => {
    expect(shouldOverfetchColbertResults("LISTENER", null)).toBe(true);
    expect(shouldOverfetchColbertResults(null, { verified: true })).toBe(true);
    expect(shouldOverfetchColbertResults("EDITOR", null)).toBe(false);
    expect(resolveColbertFetchLimit(200)).toBe(800);
  });

  it("resolves the active ColBERT bundle via the sidecar service", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body).toMatchObject({
        workflow_group_id: "20251222_144441",
        backend_key: "faster-whisper/large-v3@silero_vad_v6",
        colbert_model: "jinaai/jina-colbert-v2",
        colbert_root_dir: "/workspace/besedy/tmp/rag_colbert",
      });
      return {
        status: 200,
        ok: true,
        json: async () => ({
          colbert_index_dir:
            "/workspace/besedy/tmp/rag_colbert/20251222_144441/faster-whisper_large-v3_silero_vad_v6/v2/jinaai_jina-colbert-v2/index/colbert_index",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveColbertIndexDir({
        workflowGroupId: "20251222_144441",
        backendKey: "faster-whisper/large-v3@silero_vad_v6",
        colbertModel: "jinaai/jina-colbert-v2",
        colbertRootDir: "/workspace/besedy/tmp/rag_colbert",
        colbertUrl: "http://localhost:8192/query",
        timeoutMs: 5000,
      }),
    ).resolves.toBe(
      "/workspace/besedy/tmp/rag_colbert/20251222_144441/faster-whisper_large-v3_silero_vad_v6/v2/jinaai_jina-colbert-v2/index/colbert_index",
    );
  });

  it("returns null when the sidecar cannot resolve a valid ColBERT bundle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 404,
        ok: false,
        text: async () => "not found",
      })),
    );

    await expect(
      resolveColbertIndexDir({
        workflowGroupId: "20251222_144441",
        backendKey: "faster-whisper/large-v3@silero_vad_v6",
        colbertModel: "jinaai/jina-colbert-v2",
        colbertRootDir: "/workspace/besedy/tmp/rag_colbert",
        colbertUrl: "http://localhost:8192/query",
        timeoutMs: 5000,
      }),
    ).resolves.toBeNull();
  });

  it("applies per-audio result limits in score order", () => {
    const filtered = applyMaxPerAudio(
      [
        makeCandidate("chunk-1", "audio-a", 0.9),
        makeCandidate("chunk-2", "audio-a", 0.8),
        makeCandidate("chunk-3", "audio-b", 0.7),
      ],
      1,
    );

    expect(filtered.map((item) => item.chunkId)).toEqual(["chunk-1", "chunk-3"]);
  });

  it("scans deeper fused candidates to satisfy per-audio rerank limits", () => {
    const selected = collectRerankCandidates(
      [
        makeCandidate("chunk-a1", "audio-a", 0.9),
        makeCandidate("chunk-a2", "audio-a", 0.8),
        makeCandidate("chunk-a3", "audio-a", 0.7),
        makeCandidate("chunk-b1", "audio-b", 0.6),
        makeCandidate("chunk-c1", "audio-c", 0.5),
      ],
      3,
      1,
    );

    expect(selected.map((item) => item.chunkId)).toEqual(["chunk-a1", "chunk-b1", "chunk-c1"]);
  });

  it("assembles context text in timeline order", () => {
    const neighbors = {
      before: [
        {
          chunkId: "chunk-1",
          audioHash: "audio-a",
          startSec: 0,
          endSec: 10,
          text: "before",
        },
      ],
      after: [
        {
          chunkId: "chunk-3",
          audioHash: "audio-a",
          startSec: 20,
          endSec: 30,
          text: "after",
        },
      ],
    };

    expect(
      assembleContextText(
        {
          chunkId: "chunk-2",
          audioHash: "audio-a",
          startSec: 10,
          endSec: 20,
          text: "primary",
          runId: "run-1",
          chunkVersion: "v2",
          embeddingModel: "model-1",
          embeddingModelVersion: "1",
          denseRank: 1,
          sparseRank: 1,
          denseScore: 0.9,
          sparseScore: 0.9,
          rrfScore: 0.5,
          rerankScore: 0.9,
        },
        neighbors,
      ),
    ).toBe("before\n\nprimary\n\nafter");
  });
});
