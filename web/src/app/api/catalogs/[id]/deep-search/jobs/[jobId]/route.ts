import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import { validateParams } from "@/lib/api";
import { deepSearchJobSchema } from "@/lib/jobs-api/schemas";
import { fetchJobsApi } from "@/lib/jobs-api/server";
import {
  authorizeCatalogDeepSearchRead,
  DeepSearchJobParamSchema,
  enrichDeepSearchJobForUser,
  handleDeepSearchRouteError,
  requireReadableDeepSearchJob,
} from "../../route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; jobId: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth();
    const paramsResult = validateParams(await params, DeepSearchJobParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, jobId } = paramsResult.data;

    const accessResponse = await authorizeCatalogDeepSearchRead(userId, catalogId);
    if (accessResponse) return accessResponse;

    const job = await fetchJobsApi(`/jobs/${encodeURIComponent(jobId)}`, {
      schema: deepSearchJobSchema,
    });
    const readableResponse = await requireReadableDeepSearchJob(job, { catalogId, userId });
    if (readableResponse) return readableResponse;

    return NextResponse.json(await enrichDeepSearchJobForUser(job, { catalogId, userId }));
  } catch (error) {
    return handleDeepSearchRouteError(error, "fetch");
  }
}
