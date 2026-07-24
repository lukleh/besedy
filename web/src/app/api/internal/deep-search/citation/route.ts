import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, notFound, validateRequestBody } from "@/lib/api";
import {
  applyTimingHeaders,
  assembleContextText,
  elapsedMs,
  getSearchConfig,
  lookupColbertChunks,
  lookupColbertNeighbors,
  RagServiceError,
  type SearchTimings,
} from "@/app/api/catalogs/[id]/search/search-route-helpers";
import { resolveCatalogColbertIndexDir } from "@/app/api/catalogs/[id]/search/search-service";
import {
  authorizeDeepSearchServiceRequest,
  catalogExists,
  formatDeepSearchMetadata,
  getCatalogRecordingMetadata,
} from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CitationRequestSchema = z.object({
  catalogId: z.string().trim().min(1).max(128),
  chunkId: z.string().trim().min(1).max(256),
  neighborCount: z.number().int().min(0).max(5).optional(),
});

export async function POST(request: NextRequest) {
  const unauthorizedResponse = authorizeDeepSearchServiceRequest(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const bodyResult = await validateRequestBody(request, CitationRequestSchema);
  if (!bodyResult.success) return bodyResult.response;

  const config = getSearchConfig();
  const requestStartedAt = performance.now();
  let timings: SearchTimings = { totalMs: 0 };

  try {
    const { catalogId, chunkId } = bodyResult.data;
    const neighborCount = bodyResult.data.neighborCount ?? 1;

    if (!(await catalogExists(catalogId))) {
      return notFound("catalog");
    }

    const colbertStartedAt = performance.now();
    const colbertIndexDir = await resolveCatalogColbertIndexDir(catalogId, config);
    if (colbertIndexDir === null) {
      return apiError("ColBERT bundle not found for catalog", 404);
    }

    const [chunks, neighborsByChunkId] = await Promise.all([
      lookupColbertChunks(
        config.colbertUrl,
        colbertIndexDir,
        [chunkId],
        config.timeoutMs,
      ),
      lookupColbertNeighbors(
        config.colbertUrl,
        colbertIndexDir,
        [chunkId],
        neighborCount,
        config.timeoutMs,
      ),
    ]);
    const colbertMs = elapsedMs(colbertStartedAt);

    const chunk = chunks[0];
    if (!chunk) {
      return notFound("chunk");
    }

    const metadataStartedAt = performance.now();
    const metadata = await getCatalogRecordingMetadata(catalogId, chunk.audioHash);
    const metadataMs = elapsedMs(metadataStartedAt);
    const neighbors = neighborsByChunkId.get(chunk.chunkId) ?? { before: [], after: [] };
    const contextStartSec = neighbors.before[0]?.startSec ?? chunk.startSec;
    const contextEndSec = neighbors.after.at(-1)?.endSec ?? chunk.endSec;

    timings = {
      totalMs: elapsedMs(requestStartedAt),
      colbertMs,
      metadataMs,
    };

    const response = NextResponse.json({
      catalogId,
      chunk: {
        audioHash: chunk.audioHash,
        chunkId: chunk.chunkId,
        startSec: chunk.startSec,
        endSec: chunk.endSec,
        text: chunk.text,
      },
      contextText: assembleContextText(
        {
          chunkId: chunk.chunkId,
          audioHash: chunk.audioHash,
          startSec: chunk.startSec,
          endSec: chunk.endSec,
          text: chunk.text,
          runId: chunk.runId,
          chunkVersion: chunk.chunkVersion,
          embeddingModel: config.colbertModel,
          embeddingModelVersion: "",
          denseRank: null,
          sparseRank: null,
          denseScore: null,
          sparseScore: null,
          rrfScore: 0,
          rerankScore: null,
        },
        neighbors,
      ),
      contextStartSec,
      contextEndSec,
      neighbors,
      metadata: formatDeepSearchMetadata(metadata),
      citation: {
        audioHash: chunk.audioHash,
        chunkId: chunk.chunkId,
        startSec: chunk.startSec,
        endSec: chunk.endSec,
        workflowGroupId: catalogId,
        backendKey: config.backendKey,
        chunkVersion: chunk.chunkVersion,
      },
      provenance: {
        workflowGroupId: catalogId,
        backendKey: config.backendKey,
        runId: chunk.runId,
        chunkVersion: chunk.chunkVersion,
        embeddingModel: config.colbertModel,
        embeddingModelVersion: "",
      },
      timings,
    });
    applyTimingHeaders(response, timings);
    return response;
  } catch (error) {
    if (error instanceof RagServiceError) {
      const finalTimings: SearchTimings = {
        ...timings,
        totalMs: elapsedMs(requestStartedAt),
      };
      const response = NextResponse.json({ error: error.message }, { status: error.status });
      applyTimingHeaders(response, finalTimings);
      return response;
    }
    console.error("Internal deep-search citation lookup failed:", error);
    const finalTimings: SearchTimings = {
      ...timings,
      totalMs: elapsedMs(requestStartedAt),
    };
    const response = NextResponse.json(
      { error: "Failed to load citation context" },
      { status: 500 },
    );
    applyTimingHeaders(response, finalTimings);
    return response;
  }
}
