import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import {
  validateMutationSource,
  validateParams,
} from "@/lib/api";
import prisma from "@/lib/db";
import { deepSearchJobSchema } from "@/lib/jobs-api/schemas";
import { fetchJobsApi } from "@/lib/jobs-api/server";
import { UserIdSchema } from "@/lib/validation/schemas";
import {
  authorizeCatalogDeepSearchRead,
  DeepSearchJobParamSchema,
  handleDeepSearchRouteError,
  requireDeepSearchShareOwner,
} from "../../../../route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DeepSearchShareParamSchema = DeepSearchJobParamSchema.extend({
  userId: UserIdSchema,
});

interface RouteParams {
  params: Promise<{ id: string; jobId: string; userId: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const currentUserId = await requireAuth();
    const paramsResult = validateParams(await params, DeepSearchShareParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, jobId, userId: sharedWithUserId } = paramsResult.data;

    const accessResponse = await authorizeCatalogDeepSearchRead(currentUserId, catalogId);
    if (accessResponse) return accessResponse;

    const job = await fetchJobsApi(`/jobs/${encodeURIComponent(jobId)}`, {
      schema: deepSearchJobSchema,
    });
    const ownerResponse = requireDeepSearchShareOwner(job, {
      catalogId,
      userId: currentUserId,
    });
    if (ownerResponse) return ownerResponse;

    await prisma.deepSearchJobShare.deleteMany({
      where: {
        jobId,
        catalogId,
        ownerUserId: currentUserId,
        sharedWithUserId,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDeepSearchRouteError(error, "update");
  }
}
