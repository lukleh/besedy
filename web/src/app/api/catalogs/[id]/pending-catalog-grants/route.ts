import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import { listPendingCatalogUsers } from "@/lib/admission/catalog-read-models";
import { createPendingCatalogGrant } from "@/lib/admission/catalog-pending-grant-create";
import { resolveCatalogManagementActor } from "@/lib/access/catalog-management-route-access";
import { canAttemptCatalogManagement } from "@/lib/policy/catalog";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import {
  forbidden,
  handlePrismaError,
  notFound,
  validateParams,
} from "@/lib/api";

type RouteParams = {
  params: Promise<{ id: string }>;
};

async function withPendingCatalogGrantType(response: Response) {
  if (!response.ok) {
    return response;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return response;
  }

  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response;
  }

  return NextResponse.json(
    {
      ...body,
      type: body.userStatus === "PENDING" ? "pending_catalog_grant" : "catalog_access",
    },
    {
      status: response.status,
      headers: response.headers,
    }
  );
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth();

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) {
      return paramsResult.response;
    }
    const { id: catalogId } = paramsResult.data;

    const access = await resolveCatalogManagementActor(catalogId, {
      userId,
      activeCatalogOnly: false,
    });
    if (!access.ok) {
      return access.response;
    }

    if (!access.actor.catalogExists) {
      return notFound("catalog");
    }

    if (!canAttemptCatalogManagement(access.policyContext)) {
      return forbidden("OWNER or Admin access required to manage catalog access");
    }

    const pendingUsers = await listPendingCatalogUsers(catalogId);
    return NextResponse.json({ pendingUsers });
  } catch (error) {
    return handlePrismaError(error, "catalog pending grants", "fetch");
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const paramsResult = validateParams(await params, TimestampIdParamSchema);
  if (!paramsResult.success) {
    return paramsResult.response;
  }
  const response = await createPendingCatalogGrant(request, paramsResult.data.id);
  return withPendingCatalogGrantType(response);
}
