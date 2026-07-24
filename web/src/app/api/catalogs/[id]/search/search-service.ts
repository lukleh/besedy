import type { AccessLevel } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import {
  applyMaxPerAudio,
  applyRelativeCutoff,
  assembleContextText,
  buildAllowedAudioHashesQuery,
  collectRerankCandidates,
  elapsedMs,
  getSearchConfig,
  lookupColbertChunks,
  lookupColbertNeighbors,
  materializeColbertCandidates,
  queryColbertService,
  RagServiceError,
  resolveColbertFetchLimit,
  resolveColbertIndexDir,
  resolveRerankCandidateLimit,
  rerankCandidates,
  shouldOverfetchColbertResults,
  type AllowedAudioHashRow,
  type SearchMetadataFilters,
  type SearchTimings,
} from "./search-route-helpers";

type SearchConfig = ReturnType<typeof getSearchConfig>;

export interface CatalogSearchResult {
  rank: number;
  audioHash: string;
  chunkId: string;
  score: number;
  startSec: number;
  endSec: number;
  text: string;
  contextText: string;
  contextStartSec: number;
  contextEndSec: number;
  neighbors: {
    before: Array<{
      chunkId: string;
      audioHash: string;
      startSec: number;
      endSec: number;
      text: string;
    }>;
    after: Array<{
      chunkId: string;
      audioHash: string;
      startSec: number;
      endSec: number;
      text: string;
    }>;
  };
  metadata: {
    date: {
      year: number | null;
      month: number | null;
      day: number | null;
    };
    location: { id: number; name: string } | null;
    recorder: { id: number; name: string } | null;
  };
  citation: {
    audioHash: string;
    chunkId: string;
    startSec: number;
    endSec: number;
    workflowGroupId: string;
    backendKey: string;
    chunkVersion: string;
  };
  provenance: {
    workflowGroupId: string;
    backendKey: string;
    runId: string;
    chunkVersion: string;
    embeddingModel: string;
    embeddingModelVersion: string;
  };
}

export interface CatalogSearchExecutionResult {
  config: SearchConfig;
  query: string;
  results: CatalogSearchResult[];
  timings: SearchTimings;
  fusedCandidates: number;
}

export interface ExecuteCatalogSearchInput {
  catalogId: string;
  query: string;
  limit?: number;
  candidateLimit?: number;
  includeNeighbors?: boolean;
  neighborCount?: number;
  maxPerAudio?: number | null;
  metadataFilters?: SearchMetadataFilters | null;
  accessLevel?: AccessLevel | null;
  config?: SearchConfig;
  requestStartedAt?: number;
  authMs?: number;
  failOnMissingBundle?: boolean;
}

export async function resolveCatalogColbertIndexDir(
  catalogId: string,
  config: SearchConfig = getSearchConfig(),
): Promise<string | null> {
  return resolveColbertIndexDir({
    workflowGroupId: catalogId,
    backendKey: config.backendKey,
    colbertModel: config.colbertModel,
    colbertRootDir: config.colbertRootDir,
    colbertUrl: config.colbertUrl,
    explicitIndexDir: config.colbertIndexDir,
    timeoutMs: config.timeoutMs,
  });
}

export async function executeCatalogSearch(
  input: ExecuteCatalogSearchInput,
): Promise<CatalogSearchExecutionResult> {
  const config = input.config ?? getSearchConfig();
  const requestStartedAt = input.requestStartedAt ?? performance.now();
  const limit = input.limit ?? config.resultLimit;
  const rerankCandidateLimit = resolveRerankCandidateLimit(
    input.candidateLimit,
    limit,
    config.rerankTopN,
  );
  const neighborCount = input.includeNeighbors ? (input.neighborCount ?? 1) : 0;
  const metadataFilters = input.metadataFilters ?? null;

  let rerankMs: number | undefined;
  let fusedCandidates = 0;

  const colbertStartedAt = performance.now();
  const colbertIndexDir = await resolveCatalogColbertIndexDir(input.catalogId, config);
  if (colbertIndexDir === null) {
    if (input.failOnMissingBundle) {
      throw new RagServiceError("ColBERT bundle not found for catalog", 404);
    }
    return {
      config,
      query: input.query,
      results: [],
      fusedCandidates,
      timings: {
        totalMs: elapsedMs(requestStartedAt),
        authMs: input.authMs,
      },
    };
  }

  const requiredColbertRows = config.rerankEnabled ? rerankCandidateLimit : limit;
  const baseColbertK = Math.max(config.colbertTopK, requiredColbertRows, limit);
  const maxColbertK = shouldOverfetchColbertResults(input.accessLevel, metadataFilters)
    ? resolveColbertFetchLimit(baseColbertK)
    : baseColbertK;
  let requestedColbertK = baseColbertK;
  let colbertHits = await queryColbertService(
    input.query,
    config.colbertUrl,
    colbertIndexDir,
    requestedColbertK,
    config.timeoutMs,
  );
  let lookedUpChunks = await lookupColbertChunks(
    config.colbertUrl,
    colbertIndexDir,
    colbertHits.map((hit) => hit.chunkId),
    config.timeoutMs,
  );
  let allowedAudioQuery = buildAllowedAudioHashesQuery(
    input.catalogId,
    Array.from(new Set(lookedUpChunks.map((chunk) => chunk.audioHash))),
    input.accessLevel,
    metadataFilters,
  );
  let allowedAudioRows = allowedAudioQuery
    ? await prisma.$queryRaw<AllowedAudioHashRow[]>(allowedAudioQuery)
    : [];
  let colbertCandidates = materializeColbertCandidates(
    colbertHits,
    lookedUpChunks,
    allowedAudioRows.map((row) => row.audioHash),
    config.colbertModel,
  );
  while (
    colbertCandidates.length < requiredColbertRows &&
    requestedColbertK < maxColbertK &&
    colbertHits.length >= requestedColbertK
  ) {
    requestedColbertK = Math.min(maxColbertK, requestedColbertK * 2);
    colbertHits = await queryColbertService(
      input.query,
      config.colbertUrl,
      colbertIndexDir,
      requestedColbertK,
      config.timeoutMs,
    );
    lookedUpChunks = await lookupColbertChunks(
      config.colbertUrl,
      colbertIndexDir,
      colbertHits.map((hit) => hit.chunkId),
      config.timeoutMs,
    );
    allowedAudioQuery = buildAllowedAudioHashesQuery(
      input.catalogId,
      Array.from(new Set(lookedUpChunks.map((chunk) => chunk.audioHash))),
      input.accessLevel,
      metadataFilters,
    );
    allowedAudioRows = allowedAudioQuery
      ? await prisma.$queryRaw<AllowedAudioHashRow[]>(allowedAudioQuery)
      : [];
    colbertCandidates = materializeColbertCandidates(
      colbertHits,
      lookedUpChunks,
      allowedAudioRows.map((row) => row.audioHash),
      config.colbertModel,
    );
  }
  const colbertMs = elapsedMs(colbertStartedAt);
  fusedCandidates = colbertHits.length;

  if (colbertCandidates.length === 0) {
    return {
      config,
      query: input.query,
      results: [],
      fusedCandidates,
      timings: {
        totalMs: elapsedMs(requestStartedAt),
        authMs: input.authMs,
        colbertMs,
      },
    };
  }

  let rankedForSelection = colbertCandidates;
  if (config.rerankEnabled) {
    const rerankCandidatesInput = collectRerankCandidates(
      colbertCandidates,
      rerankCandidateLimit,
      input.maxPerAudio ?? null,
    );
    const rerankStartedAt = performance.now();
    const rerankScores = await rerankCandidates(
      input.query,
      rerankCandidatesInput,
      config.rerankUrl,
      config.timeoutMs,
    );
    rerankMs = elapsedMs(rerankStartedAt);

    rerankCandidatesInput.forEach((candidate, index) => {
      candidate.rerankScore = rerankScores[index] ?? 0;
    });
    rerankCandidatesInput.sort((a, b) => {
      const scoreDiff = (b.rerankScore ?? 0) - (a.rerankScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return b.rrfScore - a.rrfScore;
    });
    rankedForSelection = rerankCandidatesInput;
  }

  const filteredByCutoff = applyRelativeCutoff(
    rankedForSelection,
    config.relativeScoreCutoff,
  );
  const deduped = applyMaxPerAudio(filteredByCutoff, input.maxPerAudio ?? null);
  const selected = deduped.slice(0, limit);
  const audioHashes = Array.from(new Set(selected.map((item) => item.audioHash)));
  const metadataStartedAt = performance.now();
  const [metadataRows, neighborsByChunkId] = await Promise.all([
    prisma.audioMetadata.findMany({
      where: {
        workflowGroupId: input.catalogId,
        audioHash: { in: audioHashes },
      },
      include: {
        location: { select: { id: true, name: true } },
        recorder: { select: { id: true, name: true } },
      },
    }),
    lookupColbertNeighbors(
      config.colbertUrl,
      colbertIndexDir,
      selected.map((item) => item.chunkId),
      neighborCount,
      config.timeoutMs,
    ),
  ]);
  const metadataMs = elapsedMs(metadataStartedAt);

  const metadataByHash = new Map(metadataRows.map((row) => [row.audioHash, row]));
  return {
    config,
    query: input.query,
    fusedCandidates,
    timings: {
      totalMs: elapsedMs(requestStartedAt),
      authMs: input.authMs,
      colbertMs,
      rerankMs,
      metadataMs,
    },
    results: selected.map((item, index) => {
      const metadata = metadataByHash.get(item.audioHash);
      const neighbors = neighborsByChunkId.get(item.chunkId) ?? { before: [], after: [] };
      const contextStartSec = neighbors.before[0]?.startSec ?? item.startSec;
      const contextEndSec = neighbors.after.at(-1)?.endSec ?? item.endSec;
      return {
        rank: index + 1,
        audioHash: item.audioHash,
        chunkId: item.chunkId,
        score: item.rerankScore ?? item.rrfScore,
        startSec: item.startSec,
        endSec: item.endSec,
        text: item.text,
        contextText: assembleContextText(item, neighbors),
        contextStartSec,
        contextEndSec,
        neighbors,
        metadata: {
          date: {
            year: metadata?.dateYear ?? null,
            month: metadata?.dateMonth ?? null,
            day: metadata?.dateDay ?? null,
          },
          location: metadata?.location
            ? { id: metadata.location.id, name: metadata.location.name }
            : null,
          recorder: metadata?.recorder
            ? { id: metadata.recorder.id, name: metadata.recorder.name }
            : null,
        },
        citation: {
          audioHash: item.audioHash,
          chunkId: item.chunkId,
          startSec: item.startSec,
          endSec: item.endSec,
          workflowGroupId: input.catalogId,
          backendKey: config.backendKey,
          chunkVersion: item.chunkVersion,
        },
        provenance: {
          workflowGroupId: input.catalogId,
          backendKey: config.backendKey,
          runId: item.runId,
          chunkVersion: item.chunkVersion,
          embeddingModel: item.embeddingModel,
          embeddingModelVersion: item.embeddingModelVersion,
        },
      };
    }),
  };
}
