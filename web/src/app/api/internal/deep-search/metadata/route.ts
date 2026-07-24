import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { notFound, validateRequestBody } from "@/lib/api";
import {
  applyTimingHeaders,
  elapsedMs,
  type SearchTimings,
} from "@/app/api/catalogs/[id]/search/search-route-helpers";
import {
  authorizeDeepSearchServiceRequest,
  catalogExists,
  formatDeepSearchMetadata,
  getCatalogRecordingMetadata,
} from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MetadataRequestSchema = z.object({
  catalogId: z.string().trim().min(1).max(128),
  audioHash: z.string().trim().min(1).max(128),
});

export async function POST(request: NextRequest) {
  const unauthorizedResponse = authorizeDeepSearchServiceRequest(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const bodyResult = await validateRequestBody(request, MetadataRequestSchema);
  if (!bodyResult.success) return bodyResult.response;

  const requestStartedAt = performance.now();
  let timings: SearchTimings = { totalMs: 0 };

  try {
    const { catalogId, audioHash } = bodyResult.data;
    if (!(await catalogExists(catalogId))) {
      return notFound("catalog");
    }

    const metadataStartedAt = performance.now();
    const metadata = await getCatalogRecordingMetadata(catalogId, audioHash);
    timings = {
      totalMs: elapsedMs(requestStartedAt),
      metadataMs: elapsedMs(metadataStartedAt),
    };

    const response = NextResponse.json({
      catalogId,
      audioHash,
      metadata: formatDeepSearchMetadata(metadata),
      timings,
    });
    applyTimingHeaders(response, timings);
    return response;
  } catch (error) {
    console.error("Internal deep-search metadata lookup failed:", error);
    const finalTimings: SearchTimings = {
      ...timings,
      totalMs: elapsedMs(requestStartedAt),
    };
    const response = NextResponse.json(
      { error: "Failed to load recording metadata" },
      { status: 500 },
    );
    applyTimingHeaders(response, finalTimings);
    return response;
  }
}
