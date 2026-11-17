import { assertArchiveCatalogId } from '@/lib/archive';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import {
  badRequest,
  handlePrismaError,
  validateMutationSource,
  validateRequestBody,
} from '@/lib/api';
import { requireAdminCapability } from '@/lib/access/require-admin';
import { validatePath } from '@/lib/security/path-validation';
import { TimestampIdSchema } from '@/lib/validation/schemas';
import {
  ensureSharedIntakeDir,
  getIngestChunkBytes,
  getIngestMaxUploadBytes,
} from '@/lib/ingest/server';
import { getAllowedIngestExtension } from '@/lib/ingest/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateUploadSchema = z
  .object({
    catalogId: TimestampIdSchema,
    filename: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().positive(),
    mimeType: z.string().trim().max(200).nullable().optional(),
    // Where and when the recording took place; the event is created from them.
    locationId: z.number().int().positive().nullable().optional(),
    dateYear: z.number().int().min(1900).max(2100).nullable().optional(),
    dateMonth: z.number().int().min(1).max(12).nullable().optional(),
    dateDay: z.number().int().min(1).max(31).nullable().optional(),
    // Who recorded it; stored in the recording's metadata, independent of the event.
    recorderId: z.number().int().positive().nullable().optional(),
    // Shared by the files of one upload, so later files join the first one's event.
    uploadBatchId: z.string().uuid().nullable().optional(),
    // An existing event for this place and date, or a separate new one.
    targetEventId: z.number().int().positive().nullable().optional(),
    createDistinctEvent: z.boolean().optional(),
  })
  .refine((body) => (body.locationId == null) === (body.dateYear == null), {
    message: 'Location and year must be given together',
  })
  .refine((body) => body.dateDay == null || body.dateMonth != null, {
    message: 'A day needs a month',
  })
  .refine(
    (body) => (body.targetEventId == null && !body.createDistinctEvent) || body.locationId != null,
    { message: 'An event choice needs a location and date' },
  )
  .refine((body) => !(body.targetEventId != null && body.createDistinctEvent), {
    message: 'Choose an existing event or a separate new one, not both',
  })
  .refine(
    (body) =>
      body.dateYear == null ||
      body.dateMonth == null ||
      body.dateDay == null ||
      new Date(Date.UTC(body.dateYear, body.dateMonth - 1, body.dateDay)).getUTCDate() ===
        body.dateDay,
    { message: 'Invalid date' },
  );

/**
 * POST /api/admin/ingest/uploads
 * Opens a chunked upload: creates the intake row and its incoming directory.
 * The optional place and date become the recording's metadata and event, and
 * the optional recorder its metadata, once the ingest succeeds.
 */
export async function POST(request: NextRequest) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const { userId } = await requireAdminCapability({
      message: 'Unauthorized',
    });

    const bodyResult = await validateRequestBody(request, CreateUploadSchema);
    if (!bodyResult.success) return bodyResult.response;
    const {
      catalogId,
      filename,
      sizeBytes,
      mimeType,
      locationId,
      dateYear,
      dateMonth,
      dateDay,
      recorderId,
      uploadBatchId,
      targetEventId,
      createDistinctEvent,
    } = bodyResult.data;
    await assertArchiveCatalogId(catalogId);

    const extension = getAllowedIngestExtension(filename);
    if (!extension) {
      return badRequest('Unsupported file type');
    }
    if (sizeBytes > getIngestMaxUploadBytes()) {
      return NextResponse.json({ error: 'Upload too large' }, { status: 413 });
    }

    const catalog = await prisma.workflowGroup.findFirst({
      where: { id: catalogId, isActive: true },
      select: { id: true },
    });
    if (!catalog) {
      return badRequest('Catalog not found or inactive');
    }
    if (locationId != null) {
      const location = await prisma.location.findFirst({
        where: { id: locationId, workflowGroupId: catalogId },
        select: { id: true },
      });
      if (!location) {
        return badRequest('Selected location does not belong to this catalog');
      }
    }
    if (recorderId != null) {
      const recorder = await prisma.recorder.findFirst({
        where: { id: recorderId, workflowGroupId: catalogId },
        select: { id: true },
      });
      if (!recorder) {
        return badRequest('Selected recorder does not belong to this catalog');
      }
    }
    if (targetEventId != null) {
      const event = await prisma.catalogEvent.findFirst({
        where: { id: targetEventId, workflowGroupId: catalogId },
        select: { id: true },
      });
      if (!event) {
        return badRequest('Selected event does not belong to this catalog');
      }
    }

    const intake = await prisma.recordingIntake.create({
      data: {
        workflowGroupId: catalogId,
        requestedById: userId,
        originalFilename: filename,
        storedFilename: `source${extension}`,
        mimeType: mimeType ?? null,
        expectedSizeBytes: BigInt(sizeBytes),
        locationId: locationId ?? null,
        dateYear: dateYear ?? null,
        dateMonth: dateYear != null ? (dateMonth ?? null) : null,
        dateDay: dateYear != null ? (dateDay ?? null) : null,
        recorderId: recorderId ?? null,
        uploadBatchId: uploadBatchId ?? null,
        targetEventId: targetEventId ?? null,
        createDistinctEvent: createDistinctEvent ?? false,
      },
    });

    const dir = await ensureSharedIntakeDir(catalogId, intake.id);
    const dirValidation = validatePath(dir);
    if (!dirValidation.valid) {
      await prisma.recordingIntake.delete({ where: { id: intake.id } });
      return NextResponse.json(
        { error: 'Invalid uploads directory' },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { intakeId: intake.id, chunkSizeBytes: getIngestChunkBytes() },
      { status: 201 },
    );
  } catch (error) {
    return handlePrismaError(error, 'recording ingest upload', 'create');
  }
}
