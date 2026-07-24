import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { TimestampIdParamSchema, CreateVariantSchema } from "@/lib/validation/schemas";
import { validateParams, validateRequestBody, notFound, handlePrismaError } from "@/lib/api";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/catalogs/:id/variants - List all variants for a workflow group (catalog)
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminCapability({
      message: "Admin access required to manage catalog variants",
    });

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id } = paramsResult.data;

    // Check if group exists
    const group = await prisma.workflowGroup.findUnique({
      where: { id },
    });

    if (!group) {
      return notFound("catalog");
    }

    const variants = await prisma.workflowVariant.findMany({
      where: { workflowGroupId: id },
      orderBy: [{ isDefault: "desc" }, { variant: "asc" }],
    });

    return NextResponse.json(variants);
  } catch (error) {
    return handlePrismaError(error, "variants", "fetch");
  }
}

/**
 * POST /api/catalogs/:id/variants - Create a new variant for a workflow group (catalog)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminCapability({
      message: "Admin access required to manage catalog variants",
    });

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, CreateVariantSchema);
    if (!bodyResult.success) return bodyResult.response;
    const {
      variant,
      label,
      listeningArchivedCatalogPath,
      isDefault,
    } = bodyResult.data;

    // Check if group exists
    const group = await prisma.workflowGroup.findUnique({
      where: { id },
    });

    if (!group) {
      return notFound("catalog");
    }

    // If setting as default, unset other defaults first
    if (isDefault) {
      await prisma.workflowVariant.updateMany({
        where: { workflowGroupId: id, isDefault: true },
        data: { isDefault: false },
      });
    }

    const newVariant = await prisma.workflowVariant.create({
      data: {
        workflowGroupId: id,
        variant,
        label,
        listeningArchivedCatalogPath,
        isDefault: isDefault ?? false,
      },
    });

    return NextResponse.json(newVariant, { status: 201 });
  } catch (error) {
    return handlePrismaError(error, "variant", "create");
  }
}
