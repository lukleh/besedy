import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireAuth } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { validateParams, validateRequestBody, forbidden, notFound } from "@/lib/api";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { executeCatalogSearch } from "./search-service";
import {
  elapsedMs,
  getSearchConfig,
  type SearchTimings,
  applyTimingHeaders,
  logSearchTelemetry,
  RagServiceError,
  RouteParams,
  SearchRequestSchema,
} from "./search-route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getErrorType(error: unknown): string {
  if (error instanceof AuthError) return "auth";
  if (error instanceof RagServiceError) return "service";
  if (error instanceof Error) return error.name;
  return "unknown";
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const config = getSearchConfig();
  const requestStartedAt = performance.now();
  let catalogId: string | null = null;
  let userId: string | null = null;
  let queryLength = 0;
  let limit = config.resultLimit;
  let fusedCandidates = 0;
  let timings: SearchTimings = { totalMs: 0 };

  try {
    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    catalogId = paramsResult.data.id;

    const bodyResult = await validateRequestBody(request, SearchRequestSchema);
    if (!bodyResult.success) return bodyResult.response;
    const query = bodyResult.data.query;
    queryLength = query.length;
    limit = bodyResult.data.limit ?? config.resultLimit;
    const includeNeighbors = bodyResult.data.includeNeighbors ?? false;
    const maxPerAudio = bodyResult.data.dedupeByAudio ? 1 : (bodyResult.data.maxPerAudio ?? null);
    const metadataFilters = bodyResult.data.metadataFilters ?? null;

    const authStartedAt = performance.now();
    userId = await requireAuth();
    timings = { totalMs: 0, authMs: elapsedMs(authStartedAt) };

    const capability = await getCatalogCapability(catalogId, userId);
    if (!capability.catalogExists) {
      return notFound("catalog");
    }

    if (!capability.hasAccess || !capability.canUseRagSearch) {
      return forbidden("Access denied");
    }

    const execution = await executeCatalogSearch({
      config,
      catalogId,
      query,
      limit,
      candidateLimit: bodyResult.data.candidateLimit,
      includeNeighbors,
      neighborCount: bodyResult.data.neighborCount,
      maxPerAudio,
      metadataFilters,
      accessLevel: capability.accessLevel,
      requestStartedAt,
      authMs: timings.authMs,
    });
    fusedCandidates = execution.fusedCandidates;
    timings = execution.timings;

    const response = NextResponse.json({
      query: execution.query,
      results: execution.results,
    });
    applyTimingHeaders(response, execution.timings);
    logSearchTelemetry({
      status: "ok",
      catalogId,
      userId,
      retrievalMode: config.retrievalMode,
      backendKey: config.backendKey,
      queryLength,
      limit,
      rerankTopN: config.rerankEnabled ? config.rerankTopN : 0,
      fusedCandidates,
      resultCount: execution.results.length,
      timings: execution.timings,
    });
    return response;
  } catch (error) {
    const finalTimings: SearchTimings = {
      ...timings,
      totalMs: elapsedMs(requestStartedAt),
    };
    const telemetryBase = {
      status: "error" as const,
      catalogId,
      userId,
      retrievalMode: config.retrievalMode,
      backendKey: config.backendKey,
      queryLength,
      limit,
      rerankTopN: config.rerankEnabled ? config.rerankTopN : 0,
      fusedCandidates,
      resultCount: 0,
      timings: finalTimings,
      errorType: getErrorType(error),
    };

    if (error instanceof AuthError) {
      logSearchTelemetry(telemetryBase);
      const response = NextResponse.json({ error: error.message }, { status: error.statusCode });
      applyTimingHeaders(response, finalTimings);
      return response;
    }
    if (error instanceof RagServiceError) {
      logSearchTelemetry(telemetryBase);
      const response = NextResponse.json({ error: error.message }, { status: error.status });
      applyTimingHeaders(response, finalTimings);
      return response;
    }
    console.error("RAG search failed:", error);
    logSearchTelemetry(telemetryBase);
    const response = NextResponse.json(
      { error: "Failed to execute search" },
      { status: 500 },
    );
    applyTimingHeaders(response, finalTimings);
    return response;
  }
}
