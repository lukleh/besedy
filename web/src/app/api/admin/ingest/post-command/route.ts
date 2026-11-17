import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireArchive } from "@/lib/archive";
import { handlePrismaError, validateMutationSource, validateRequestBody } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { logCatalogLifecycleEvent } from "@/lib/audit/logger";
import { postIngestCommandSchema } from "@/lib/ingest/post-command";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/ingest/post-command
 * The command the host worker runs after a successful ingest of the archive.
 */
export async function GET() {
  try {
    await requireAdminCapability({ message: "Unauthorized" });
    const archive = await requireArchive();
    const group = await prisma.workflowGroup.findUnique({
      where: { id: archive.id },
      select: { ingestPostCommand: true },
    });
    return NextResponse.json({ command: group?.ingestPostCommand ?? null });
  } catch (error) {
    return handlePrismaError(error, "post-ingest command", "fetch");
  }
}

/**
 * PUT /api/admin/ingest/post-command  { command: string | null }
 * Admin only. The host worker runs the command with its user's privileges, so
 * every change is audited with the previous and the new value.
 */
export async function PUT(request: NextRequest) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;
    const { userId } = await requireAdminCapability({ message: "Unauthorized" });

    const bodyResult = await validateRequestBody(request, postIngestCommandSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { command } = bodyResult.data;

    const archive = await requireArchive();
    const previous = await prisma.workflowGroup.findUnique({
      where: { id: archive.id },
      select: { ingestPostCommand: true },
    });
    const previousCommand = previous?.ingestPostCommand ?? null;
    if (previousCommand !== command) {
      await prisma.workflowGroup.update({
        where: { id: archive.id },
        data: { ingestPostCommand: command },
      });
      await logCatalogLifecycleEvent({
        action: "CATALOG_UPDATED",
        actorId: userId,
        catalogId: archive.id,
        catalogLabel: archive.label,
        details: {
          field: "ingestPostCommand",
          previous: previousCommand,
          next: command,
        },
      });
    }
    return NextResponse.json({ command });
  } catch (error) {
    return handlePrismaError(error, "post-ingest command", "update");
  }
}
