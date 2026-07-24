import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import {
  validateParams,
  validateSearchParams,
} from "@/lib/api";
import prisma from "@/lib/db";
import { deepSearchJobSchema } from "@/lib/jobs-api/schemas";
import { fetchJobsApi } from "@/lib/jobs-api/server";
import { UserSearchQuerySchema } from "@/lib/validation/schemas";
import {
  authorizeCatalogDeepSearchRead,
  DeepSearchJobParamSchema,
  handleDeepSearchRouteError,
  requireDeepSearchShareOwner,
} from "../../../route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; jobId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
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

    const queryResult = validateSearchParams(
      request.nextUrl.searchParams,
      UserSearchQuerySchema
    );
    if (!queryResult.success) return queryResult.response;

    const search = queryResult.data.search?.trim();
    if (!search || search.length < 2) {
      return NextResponse.json({ users: [] });
    }

    const existingShares = await prisma.deepSearchJobShare.findMany({
      where: {
        jobId,
        catalogId,
      },
      select: {
        sharedWithUserId: true,
      },
    });
    const excludedUserIds = [
      userId,
      ...existingShares.map((share) => share.sharedWithUserId),
    ];

    const users = await prisma.user.findMany({
      where: {
        status: "ACTIVE",
        id: {
          notIn: excludedUserIds,
        },
        OR: [
          { email: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
        ],
        AND: [
          {
            OR: [
              { isAdmin: true },
              { isSuperadmin: true },
              {
                catalogAccess: {
                  some: {
                    catalogId,
                    status: "ACTIVE",
                  },
                },
              },
            ],
          },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
      },
      orderBy: [
        { name: "asc" },
        { email: "asc" },
      ],
      take: 10,
    });

    return NextResponse.json({
      users: users.map((user) => ({
        ...user,
        type: "available" as const,
      })),
    });
  } catch (error) {
    return handleDeepSearchRouteError(error, "fetch");
  }
}
