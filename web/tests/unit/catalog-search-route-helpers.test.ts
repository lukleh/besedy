import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PER_AUDIO_LIMIT,
  SearchRequestSchema,
  applyMaxPerAudio,
  assembleContextText,
  buildAllowedAudioHashesQuery,
  buildEligibleAudioHashesQuery,
  collectRerankCandidates,
  getSearchConfig,
  queryLexicalService,
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

  it("accepts bounded event ID metadata filters", () => {
    expect(
      SearchRequestSchema.safeParse({
        query: "topic",
        metadataFilters: { eventIds: [42, 57] },
      }).success,
    ).toBe(true);
    expect(
      SearchRequestSchema.safeParse({
        query: "topic",
        metadataFilters: { eventIds: [0] },
      }).success,
    ).toBe(false);
  });

  it("restricts allowed recording hashes to linked events", () => {
    const query = buildAllowedAudioHashesQuery("catalog-a", ["audio-a", "audio-b"], "VIEWER", {
      eventIds: [42, 57],
    });
    const sql = query?.strings.join(" ? ") ?? "";

    expect(sql).toContain("FROM catalog_event_recording cer");
    expect(sql).toContain("cer.workflow_group_id = ce.workflow_group_id");
    expect(sql).toContain("cer.audio_hash = ce.audio_hash");
    expect(sql).toContain("cer.event_id IN");
    expect(query?.values).toEqual(
      expect.arrayContaining([42, 57, "catalog-a", "audio-a", "audio-b"]),
    );
  });

  it("builds a complete eligible-recording query with the same metadata filters", () => {
    const query = buildEligibleAudioHashesQuery("catalog-a", "LISTENER", {
      eventIds: [42],
      locationIds: [7],
      recorderIds: [3],
      dateYears: [2026],
      verified: true,
    });
    const sql = query.strings.join(" ? ");

    expect(sql).not.toContain("ce.audio_hash IN");
    expect(sql).toContain("ce.is_actionable = true");
    expect(sql).toContain("ce.is_published = true");
    expect(sql).toContain("FROM catalog_event_recording cer");
    expect(sql).toContain("INNER JOIN audio_metadata am");
    expect(query.values).toEqual(expect.arrayContaining([42, 7, 3, 2026, true, "catalog-a"]));
  });

  it("sends authorization scope and lexical controls to the FTS sidecar", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        total_matches: 4,
        matches: [
          {
            chunk_id: "chunk-1",
            audio_hash: "a".repeat(64),
            start_sec: 5,
            end_sec: 10,
            text: "literal evidence",
            run_id: "run-1",
            chunk_version: "v2",
            score: -1.25,
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      queryLexicalService(
        "literal phrase",
        "phrase",
        "http://localhost:8192/query",
        "/bundle/colbert_index",
        ["a".repeat(64)],
        50,
        10,
        5_000,
      ),
    ).resolves.toMatchObject({
      totalMatches: 4,
      matches: [{ chunkId: "chunk-1", score: -1.25 }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8192/lexical-search",
      expect.objectContaining({
        body: JSON.stringify({
          colbert_index_dir: "/bundle/colbert_index",
          query: "literal phrase",
          match_mode: "phrase",
          allowed_audio_hashes: ["a".repeat(64)],
          limit: 50,
          max_per_audio: 10,
        }),
      }),
    );
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
