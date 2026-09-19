import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import { validateParams, validateSearchParams } from "@/lib/api";
import prisma from "@/lib/db";
import { deepSearchJobSchema } from "@/lib/jobs-api/schemas";
import { fetchJobsApi } from "@/lib/jobs-api/server";
import { canViewCatalogTranscripts } from "@/lib/policy/catalog";
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

    const accessResponse = await authorizeCatalogDeepSearchRead(
      userId,
      catalogId
    );
    if (accessResponse) return accessResponse;

    const job = await fetchJobsApi(`/jobs/${encodeURIComponent(jobId)}`, {
      schema: deepSearchJobSchema,
    });
    const ownerResponse = requireDeepSearchShareOwner(job, {
      catalogId,
      userId,
    });
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

    const users: Array<{
      id: string;
      name: string | null;
      email: string | null;
      image: string | null;
    }> = [];
    let cursor: string | undefined;

    // Search in bounded pages, then apply the same permission predicate used by
    // transcript reads. The query only narrows to plausible candidates; it does
    // not duplicate which roles happen to carry read_transcripts.
    while (users.length < 10) {
      const candidates = await prisma.user.findMany({
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
          isAdmin: true,
          isSuperadmin: true,
          catalogAccess: {
            where: {
              catalogId,
              status: "ACTIVE",
            },
            select: {
              accessLevel: true,
              role: true,
              extraPermissions: true,
            },
            take: 1,
          },
        },
        orderBy: [{ name: "asc" }, { email: "asc" }, { id: "asc" }],
        take: 50,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      for (const candidate of candidates) {
        const access = candidate.catalogAccess[0];
        const isSystemAdmin = candidate.isAdmin || candidate.isSuperadmin;
        const catalogGrant =
          !isSystemAdmin && access
            ? {
                level: access.accessLevel,
                role: access.role,
                extras: access.extraPermissions,
              }
            : null;
        if (
          canViewCatalogTranscripts({
            catalogExists: true,
            canEnterPortal: true,
            catalogGrant,
            isCatalogAdmin:
              isSystemAdmin || catalogGrant?.role === "catalog_admin",
          })
        ) {
          users.push({
            id: candidate.id,
            name: candidate.name,
            email: candidate.email,
            image: candidate.image,
          });
          if (users.length === 10) break;
        }
      }

      if (candidates.length < 50) break;
      cursor = candidates.at(-1)?.id;
      if (!cursor) break;
    }

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
