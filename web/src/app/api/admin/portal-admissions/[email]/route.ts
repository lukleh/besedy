import { NextRequest, NextResponse } from "next/server";
import {
  deleteAdminPendingRecord,
  getAdminPendingRecord,
  patchAdminPendingRecord,
} from "@/lib/admission/admin-pending-record-route";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ email: string }>;
};

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

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { email } = await params;
  const response = await getAdminPendingRecord(email);
  return withPortalAdmissionType(response);
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { email } = await params;
  const response = await patchAdminPendingRecord(email, request);
  return withPortalAdmissionType(response);
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { email } = await params;
  return deleteAdminPendingRecord(email);
}
