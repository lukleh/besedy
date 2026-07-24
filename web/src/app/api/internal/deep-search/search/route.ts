import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { notFound, validateRequestBody } from "@/lib/api";
import { executeCatalogSearch } from "@/app/api/catalogs/[id]/search/search-service";
import {
  applyTimingHeaders,
  elapsedMs,
  getSearchConfig,
  RagServiceError,
  SearchRequestSchema,
  type SearchTimings,
} from "@/app/api/catalogs/[id]/search/search-route-helpers";
import {
  authorizeDeepSearchServiceRequest,
  catalogExists,
} from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InternalDeepSearchRequestSchema = SearchRequestSchema.extend({
  catalogId: z.string().trim().min(1).max(128),
  limit: z.number().int().min(1).max(200).optional(),
});

export async function POST(request: NextRequest) {
  const unauthorizedResponse = authorizeDeepSearchServiceRequest(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const bodyResult = await validateRequestBody(request, InternalDeepSearchRequestSchema);
  if (!bodyResult.success) return bodyResult.response;

  const config = getSearchConfig();
  const requestStartedAt = performance.now();
  let timings: SearchTimings = { totalMs: 0 };

  try {
    if (!(await catalogExists(bodyResult.data.catalogId))) {
      return notFound("catalog");
    }

    const execution = await executeCatalogSearch({
      config,
      catalogId: bodyResult.data.catalogId,
      query: bodyResult.data.query,
      limit: bodyResult.data.limit ?? config.resultLimit,
      candidateLimit: bodyResult.data.candidateLimit,
      includeNeighbors: bodyResult.data.includeNeighbors ?? false,
      neighborCount: bodyResult.data.neighborCount,
      maxPerAudio: bodyResult.data.dedupeByAudio ? 1 : (bodyResult.data.maxPerAudio ?? null),
      metadataFilters: bodyResult.data.metadataFilters ?? null,
      accessLevel: null,
      failOnMissingBundle: true,
      requestStartedAt,
    });
    timings = execution.timings;

    const response = NextResponse.json({
      catalogId: bodyResult.data.catalogId,
      query: execution.query,
      results: execution.results,
      timings: execution.timings,
      retrieval: {
        backendKey: execution.config.backendKey,
        retrievalMode: execution.config.retrievalMode,
        rerankEnabled: execution.config.rerankEnabled,
        rerankTopN: execution.config.rerankTopN,
        fusedCandidates: execution.fusedCandidates,
      },
    });
    applyTimingHeaders(response, execution.timings);
    return response;
  } catch (error) {
    const finalTimings: SearchTimings = {
      ...timings,
      totalMs: elapsedMs(requestStartedAt),
    };
    if (error instanceof RagServiceError) {
      const response = NextResponse.json({ error: error.message }, { status: error.status });
      applyTimingHeaders(response, finalTimings);
      return response;
    }
    console.error("Internal deep-search retrieval failed:", error);
    const response = NextResponse.json(
      { error: "Failed to execute internal deep-search retrieval" },
      { status: 500 },
    );
    applyTimingHeaders(response, finalTimings);
    return response;
  }
}
