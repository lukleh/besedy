import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import {
  validateMutationSource,
  validateParams,
  validateRequestBody,
} from "@/lib/api";
import {
  deepSearchJobSchema,
  deepSearchJobsListSchema,
  deepSearchSubmitInputSchema,
  type DeepSearchJob,
} from "@/lib/jobs-api/schemas";
import { fetchJobsApi, JobsApiError } from "@/lib/jobs-api/server";
import prisma from "@/lib/db";
import {
  authorizeCatalogDeepSearch,
  authorizeCatalogDeepSearchRead,
  DeepSearchCatalogParamSchema,
  handleDeepSearchRouteError,
  enrichDeepSearchJobForUser,
  isOwnedDeepSearchJob,
  requireOwnedDeepSearchJob,
} from "../route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth();
    const paramsResult = validateParams(await params, DeepSearchCatalogParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const catalogId = paramsResult.data.id;

    const accessResponse = await authorizeCatalogDeepSearchRead(userId, catalogId);
    if (accessResponse) return accessResponse;

    const scope =
      _request.nextUrl.searchParams.get("scope") === "shared" ? "shared" : "mine";

    if (scope === "shared") {
      const jobs = await listSharedJobs({ catalogId, userId });
      return NextResponse.json({ jobs });
    }

    const data = await fetchJobsApi("/jobs", {
      searchParams: {
        kind: "DEEP_SEARCH",
        catalogId,
        requestedById: userId,
        limit: 100,
      },
      schema: deepSearchJobsListSchema,
    });

    const jobs: DeepSearchJob[] = [];
    for (const job of data.jobs) {
      const enriched = await enrichDeepSearchJobForUser(job, { catalogId, userId });
      if (enriched && isOwnedDeepSearchJob(job, { catalogId, userId })) {
        jobs.push(enriched);
      }
    }

    return NextResponse.json({
      jobs,
    });
  } catch (error) {
    return handleDeepSearchRouteError(error, "fetch");
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const userId = await requireAuth();
    const paramsResult = validateParams(await params, DeepSearchCatalogParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const catalogId = paramsResult.data.id;

    const accessResponse = await authorizeCatalogDeepSearch(userId, catalogId);
    if (accessResponse) return accessResponse;

    const bodyResult = await validateRequestBody(request, deepSearchSubmitInputSchema);
    if (!bodyResult.success) return bodyResult.response;
    const instructions = bodyResult.data.instructions?.trim();

    const job = await fetchJobsApi(
      `/catalogs/${encodeURIComponent(catalogId)}/deep-search/jobs`,
      {
        method: "POST",
        body: {
          query: bodyResult.data.query,
          ...(instructions ? { instructions } : {}),
          requestedById: userId,
          callerScope: userId,
        },
        schema: deepSearchJobSchema,
      }
    );

    const ownershipResponse = requireOwnedDeepSearchJob(job, { catalogId, userId });
    if (ownershipResponse) return ownershipResponse;

    return NextResponse.json(job);
  } catch (error) {
    return handleDeepSearchRouteError(error, "create");
  }
}

async function listSharedJobs({
  catalogId,
  userId,
}: {
  catalogId: string;
  userId: string;
}): Promise<DeepSearchJob[]> {
  const shares = await prisma.deepSearchJobShare.findMany({
    where: {
      catalogId,
      sharedWithUserId: userId,
      sharedWithUser: {
        status: "ACTIVE",
      },
    },
    include: {
      sharedByUser: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 100,
  });

  const jobs: DeepSearchJob[] = [];
  for (const share of shares) {
    try {
      const job = await fetchJobsApi(`/jobs/${encodeURIComponent(share.jobId)}`, {
        schema: deepSearchJobSchema,
      });
      if (job.kind !== "DEEP_SEARCH" || job.catalog_id !== catalogId) {
        continue;
      }
      jobs.push({
        ...job,
        access: "shared",
        sharedBy: share.sharedByUser,
        sharedAt: share.createdAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof JobsApiError && error.status === 404) {
        continue;
      }
      throw error;
    }
  }
  return jobs;
}
