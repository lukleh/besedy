import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import {
  ApiErrorCode,
  badRequest,
  handlePrismaError,
  internalError,
  notFound,
} from "@/lib/api";
import { AuthError } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import {
  canAccessCatalogDeepSearch,
  getLabsPreferenceForUser,
  isFeatureEnabledForUser,
} from "@/lib/features/capabilities";
import prisma from "@/lib/db";
import { TimestampIdSchema } from "@/lib/validation/schemas";
import {
  JobsApiConfigurationError,
  JobsApiError,
} from "@/lib/jobs-api/server";
import type { DeepSearchJob } from "@/lib/jobs-api/schemas";

type DeepSearchAccess = "owner" | "shared";

export const DeepSearchCatalogParamSchema = z.object({
  id: TimestampIdSchema,
});

export const DeepSearchJobParamSchema = z.object({
  id: TimestampIdSchema,
  jobId: z.string().uuid("Invalid deep-search job id"),
});

export async function authorizeCatalogDeepSearch(
  userId: string,
  catalogId: string
): Promise<NextResponse | null> {
  if (await canAccessCatalogDeepSearch(userId, catalogId)) {
    return null;
  }
  return notFound("deep search");
}

export async function authorizeCatalogDeepSearchRead(
  userId: string,
  catalogId: string
): Promise<NextResponse | null> {
  const [capability, labsPreference] = await Promise.all([
    getCatalogCapability(catalogId, userId),
    getLabsPreferenceForUser(userId),
  ]);
  if (
    capability.catalogExists &&
    capability.hasAccess &&
    isFeatureEnabledForUser("deep-search", labsPreference.enabled)
  ) {
    return null;
  }
  return notFound("deep search");
}

export async function userHasCatalogAccess(
  userId: string,
  catalogId: string
): Promise<boolean> {
  const capability = await getCatalogCapability(catalogId, userId);
  return capability.catalogExists && capability.hasAccess;
}

export function isOwnedDeepSearchJob(
  job: DeepSearchJob,
  {
    catalogId,
    userId,
  }: {
    catalogId: string;
    userId: string;
  }
) {
  return (
    job.kind === "DEEP_SEARCH" &&
    job.catalog_id === catalogId &&
    job.requested_by_id === userId
  );
}

export function requireOwnedDeepSearchJob(
  job: DeepSearchJob,
  {
    catalogId,
    userId,
  }: {
    catalogId: string;
    userId: string;
  }
): NextResponse | null {
  if (isOwnedDeepSearchJob(job, { catalogId, userId })) {
    return null;
  }
  return notFound("deep search job");
}

export async function resolveDeepSearchJobAccess(
  job: DeepSearchJob,
  {
    catalogId,
    userId,
  }: {
    catalogId: string;
    userId: string;
  }
): Promise<DeepSearchAccess | null> {
  if (isOwnedDeepSearchJob(job, { catalogId, userId })) {
    return "owner";
  }
  if (job.kind !== "DEEP_SEARCH" || job.catalog_id !== catalogId) {
    return null;
  }

  const share = await prisma.deepSearchJobShare.findUnique({
    where: {
      jobId_sharedWithUserId: {
        jobId: job.id,
        sharedWithUserId: userId,
      },
    },
    select: {
      id: true,
      catalogId: true,
    },
  });
  return share?.catalogId === catalogId ? "shared" : null;
}

export async function requireReadableDeepSearchJob(
  job: DeepSearchJob,
  {
    catalogId,
    userId,
  }: {
    catalogId: string;
    userId: string;
  }
): Promise<NextResponse | null> {
  if (await resolveDeepSearchJobAccess(job, { catalogId, userId })) {
    return null;
  }
  return notFound("deep search job");
}

export async function enrichDeepSearchJobForUser(
  job: DeepSearchJob,
  {
    catalogId,
    userId,
  }: {
    catalogId: string;
    userId: string;
  }
): Promise<DeepSearchJob | null> {
  const access = await resolveDeepSearchJobAccess(job, { catalogId, userId });
  if (!access) {
    return null;
  }
  return {
    ...job,
    access,
  };
}

export function requireDeepSearchShareOwner(
  job: DeepSearchJob,
  {
    catalogId,
    userId,
  }: {
    catalogId: string;
    userId: string;
  }
): NextResponse | null {
  const ownershipResponse = requireOwnedDeepSearchJob(job, { catalogId, userId });
  if (ownershipResponse) {
    return ownershipResponse;
  }
  return null;
}

export function handleDeepSearchRouteError(
  error: unknown,
  operation: "fetch" | "create" | "update"
): NextResponse {
  if (error instanceof JobsApiConfigurationError) {
    return internalError("Deep search jobs service is not configured");
  }

  if (error instanceof JobsApiError) {
    if (error.status === 400) {
      return badRequest(error.message);
    }
    if (error.status === 404) {
      return notFound("deep search job");
    }

    console.error("Deep search jobs service request failed:", error);
    return NextResponse.json(
      {
        error: "Deep search jobs service is unavailable",
        code: ApiErrorCode.INTERNAL,
      },
      { status: 502 }
    );
  }

  if (error instanceof ZodError) {
    console.error("Deep search jobs service returned an invalid payload:", error);
    return NextResponse.json(
      {
        error: "Deep search jobs service returned an invalid payload",
        code: ApiErrorCode.INTERNAL,
      },
      { status: 502 }
    );
  }

  if (error instanceof AuthError) {
    return handlePrismaError(error, "deep search job", operation);
  }

  return handlePrismaError(error, "deep search job", operation);
}
