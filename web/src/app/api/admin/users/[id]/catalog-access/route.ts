import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { UserIdParamSchema } from "@/lib/validation/schemas";
import { validateParams, notFound, handlePrismaError } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/admin/users/:id/catalog-access - Get user's catalog access
 * Returns all catalogs the user has access to
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const paramsResult = validateParams(await params, UserIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id } = paramsResult.data;

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!user) {
      return notFound("user");
    }

    // Get all catalog access for this user
    const catalogAccess = await prisma.catalogAccess.findMany({
      where: { userId: id, status: "ACTIVE" },
      select: {
        catalogId: true,
        accessLevel: true,
        catalog: {
          select: { id: true, label: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Transform to match the expected interface
    const result = catalogAccess.map((access) => ({
      catalogId: access.catalogId,
      catalogLabel: access.catalog.label,
      accessLevel: access.accessLevel,
    }));

    return NextResponse.json(result);
  } catch (error) {
    return handlePrismaError(error, "catalog access", "fetch");
  }
}
