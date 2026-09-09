import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import prisma from "@/lib/db";
import {
  badRequest,
  handlePrismaError,
  validateMutationSource,
  validateRequestBody,
} from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { validatePath } from "@/lib/security/path-validation";
import { TimestampIdSchema } from "@/lib/validation/schemas";
import {
  ensureSharedIntakeDir,
  getIngestChunkBytes,
  getIngestMaxUploadBytes,
  getSafeAudioExtension,
} from "@/lib/ingest/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateUploadSchema = z.object({
  catalogId: TimestampIdSchema,
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  mimeType: z.string().trim().max(200).nullable().optional(),
});

/**
 * POST /api/admin/ingest/uploads
 * Opens a chunked upload: creates the intake row and its incoming directory.
 */
export async function POST(request: NextRequest) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const { userId } = await requireAdminCapability({ message: "Unauthorized" });

    const bodyResult = await validateRequestBody(request, CreateUploadSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { catalogId, filename, sizeBytes, mimeType } = bodyResult.data;

    const extension = getSafeAudioExtension(filename);
    if (!extension) {
      return badRequest("Unsupported file type");
    }
    if (sizeBytes > getIngestMaxUploadBytes()) {
      return NextResponse.json({ error: "Upload too large" }, { status: 413 });
    }

    const catalog = await prisma.workflowGroup.findFirst({
      where: { id: catalogId, isActive: true },
      select: { id: true },
    });
    if (!catalog) {
      return badRequest("Catalog not found or inactive");
    }

    const intake = await prisma.recordingIntake.create({
      data: {
        workflowGroupId: catalogId,
        requestedById: userId,
        originalFilename: filename,
        storedFilename: `source${extension}`,
        mimeType: mimeType ?? null,
        expectedSizeBytes: BigInt(sizeBytes),
      },
    });

    const dir = await ensureSharedIntakeDir(catalogId, intake.id);
    const dirValidation = validatePath(dir);
    if (!dirValidation.valid) {
      await prisma.recordingIntake.delete({ where: { id: intake.id } });
      return NextResponse.json({ error: "Invalid uploads directory" }, { status: 500 });
    }
    await fs.writeFile(path.join(dirValidation.resolvedPath, intake.storedFilename), "");

    return NextResponse.json(
      { intakeId: intake.id, chunkSizeBytes: getIngestChunkBytes() },
      { status: 201 }
    );
  } catch (error) {
    return handlePrismaError(error, "recording ingest upload", "create");
  }
}
