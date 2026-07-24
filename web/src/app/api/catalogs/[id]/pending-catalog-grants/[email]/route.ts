import type { NextRequest } from "next/server";
import {
  deletePendingCatalogRecord,
  updatePendingCatalogRecord,
} from "@/lib/admission/catalog-pending-record-route";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ id: string; email: string }>;
};

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id, email } = await params;
  return deletePendingCatalogRecord(id, email);
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id, email } = await params;
  return updatePendingCatalogRecord(id, email, request);
}
