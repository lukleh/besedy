import { NextRequest, NextResponse } from "next/server";
import { handlePrismaError, validateSearchParams } from "@/lib/api";
import { listPendingAdminAdmissions } from "@/lib/admission/admin-read-models";
import { z } from "zod";
import { createPortalAdmission } from "@/lib/admission/admin-portal-admission-create";
import { requireAdminCapability } from "@/lib/access/require-admin";

const PortalAdmissionListQuerySchema = z.object({
  search: z.string().optional(),
});

async function withPortalAdmissionType(response: Response) {
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
      type: "portal_admission" as const,
    },
    {
      status: response.status,
      headers: response.headers,
    }
  );
}

export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const queryResult = validateSearchParams(
      request.nextUrl.searchParams,
      PortalAdmissionListQuerySchema
    );
    if (!queryResult.success) {
      return queryResult.response;
    }

    const pendingAdmissions = await listPendingAdminAdmissions(queryResult.data.search);
    return NextResponse.json(
      pendingAdmissions.map((admission) => ({
        ...admission,
        type: "portal_admission" as const,
      }))
    );
  } catch (error) {
    return handlePrismaError(error, "portal admissions", "fetch");
  }
}

export async function POST(request: NextRequest) {
  const response = await createPortalAdmission(request);
  return withPortalAdmissionType(response);
}
