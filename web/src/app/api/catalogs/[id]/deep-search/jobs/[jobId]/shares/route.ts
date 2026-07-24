import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import {
  badRequest,
  validateMutationSource,
  validateParams,
  validateRequestBody,
} from "@/lib/api";
import prisma from "@/lib/db";
import {
  deepSearchCreateShareInputSchema,
  deepSearchJobSchema,
} from "@/lib/jobs-api/schemas";
import { fetchJobsApi } from "@/lib/jobs-api/server";
import {
  authorizeCatalogDeepSearchRead,
  DeepSearchJobParamSchema,
  handleDeepSearchRouteError,
  requireDeepSearchShareOwner,
  userHasCatalogAccess,
} from "../../../route-helpers";

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
    const ownerResponse = requireDeepSearchShareOwner(job, { catalogId, userId });
    if (ownerResponse) return ownerResponse;

    const shares = await prisma.deepSearchJobShare.findMany({
      where: {
        jobId,
        catalogId,
        ownerUserId: userId,
      },
      include: {
        sharedWithUser: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return NextResponse.json({
      shares: shares.map((share) => ({
        id: share.id,
        jobId: share.jobId,
        catalogId: share.catalogId,
        ownerUserId: share.ownerUserId,
        sharedWithUserId: share.sharedWithUserId,
        createdAt: share.createdAt.toISOString(),
        user: share.sharedWithUser,
      })),
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
    const paramsResult = validateParams(await params, DeepSearchJobParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, jobId } = paramsResult.data;

    const accessResponse = await authorizeCatalogDeepSearchRead(userId, catalogId);
    if (accessResponse) return accessResponse;

    const bodyResult = await validateRequestBody(
      request,
      deepSearchCreateShareInputSchema
    );
    if (!bodyResult.success) return bodyResult.response;

    const job = await fetchJobsApi(`/jobs/${encodeURIComponent(jobId)}`, {
      schema: deepSearchJobSchema,
    });
    const ownerResponse = requireDeepSearchShareOwner(job, { catalogId, userId });
    if (ownerResponse) return ownerResponse;

    const targetUserId = bodyResult.data.userId;
    if (targetUserId === userId) {
      return badRequest("Cannot share a deep-search job with yourself");
    }
    if (!(await userHasCatalogAccess(targetUserId, catalogId))) {
      return badRequest("User does not have access to this catalog");
    }

    const share = await prisma.deepSearchJobShare.upsert({
      where: {
        jobId_sharedWithUserId: {
          jobId,
          sharedWithUserId: targetUserId,
        },
      },
      update: {},
      create: {
        jobId,
        catalogId,
        ownerUserId: userId,
        sharedWithUserId: targetUserId,
        sharedByUserId: userId,
      },
      include: {
        sharedWithUser: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    return NextResponse.json({
      id: share.id,
      jobId: share.jobId,
      catalogId: share.catalogId,
      ownerUserId: share.ownerUserId,
      sharedWithUserId: share.sharedWithUserId,
      createdAt: share.createdAt.toISOString(),
      user: share.sharedWithUser,
    });
  } catch (error) {
    return handleDeepSearchRouteError(error, "create");
  }
}
