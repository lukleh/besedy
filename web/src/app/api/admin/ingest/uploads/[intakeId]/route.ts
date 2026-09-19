import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { conflict, handlePrismaError, notFound, validateMutationSource, validateParams } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { CuidSchema } from "@/lib/validation/schemas";
import { removeIntakeDir } from "@/lib/ingest/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IntakeParamSchema = z.object({ intakeId: CuidSchema });

interface RouteParams {
  params: Promise<{ intakeId: string }>;
}

/**
 * DELETE /api/admin/ingest/uploads/:intakeId
 * Aborts an upload that has not been finalized yet.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    await requireAdminCapability({ message: "Unauthorized" });

    const paramsResult = validateParams(await params, IntakeParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { intakeId } = paramsResult.data;

    const intake = await prisma.recordingIntake.findUnique({ where: { id: intakeId } });
    if (!intake) return notFound("intake");
    if (intake.status !== "UPLOADING") {
      return conflict("Only uploads that have not been submitted can be aborted");
    }

    await removeIntakeDir(intake.workflowGroupId, intake.id);
    await prisma.recordingIntake.delete({ where: { id: intake.id } });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handlePrismaError(error, "recording ingest upload", "delete");
  }
}
