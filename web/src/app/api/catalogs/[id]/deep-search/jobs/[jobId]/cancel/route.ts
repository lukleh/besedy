import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import { validateMutationSource, validateParams } from "@/lib/api";
import { deepSearchJobSchema } from "@/lib/jobs-api/schemas";
import { fetchJobsApi } from "@/lib/jobs-api/server";
import {
  authorizeCatalogDeepSearch,
  DeepSearchJobParamSchema,
  handleDeepSearchRouteError,
  requireOwnedDeepSearchJob,
} from "../../../route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; jobId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const userId = await requireAuth();
    const paramsResult = validateParams(await params, DeepSearchJobParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, jobId } = paramsResult.data;

    const accessResponse = await authorizeCatalogDeepSearch(userId, catalogId);
    if (accessResponse) return accessResponse;

    const currentJob = await fetchJobsApi(`/jobs/${encodeURIComponent(jobId)}`, {
      schema: deepSearchJobSchema,
    });
    const currentOwnershipResponse = requireOwnedDeepSearchJob(currentJob, {
      catalogId,
      userId,
    });
    if (currentOwnershipResponse) return currentOwnershipResponse;

    const cancelledJob = await fetchJobsApi(
      `/jobs/${encodeURIComponent(jobId)}/cancel`,
      {
        method: "POST",
        schema: deepSearchJobSchema,
      }
    );
    const cancelledOwnershipResponse = requireOwnedDeepSearchJob(cancelledJob, {
      catalogId,
      userId,
    });
    if (cancelledOwnershipResponse) return cancelledOwnershipResponse;

    return NextResponse.json(cancelledJob);
  } catch (error) {
    return handleDeepSearchRouteError(error, "update");
  }
}
