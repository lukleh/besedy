import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireAuth } from "@/lib/auth/permissions";
import { getRecordingCapability } from "@/lib/access/capabilities";
import {
  logAccessDenied,
  logContentEvent,
  logMetadataUpdated,
  logMetadataVerified,
} from "@/lib/audit/logger";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { validateParams, validateRequestBody, notFound, forbidden, handlePrismaError } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

// Extended schema for recording metadata (includes more fields)
// Note: recorderId/locationId/albumId are Int in Prisma (autoincrement), not CUID
const RecordingMetadataBodySchema = z.object({
  title: z.string().max(200).nullish(),
  artist: z.string().max(200).nullish(),
  albumId: z.number().int().positive().nullish(),
  dateYear: z.number().int().min(1900).max(2100).nullish(),
  dateMonth: z.number().int().min(1).max(12).nullish(),
  dateDay: z.number().int().min(1).max(31).nullish(),
  notes: z.string().max(2000).nullish(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  verified: z.boolean().optional(),
  recorderId: z.number().int().positive().nullish(),
  locationId: z.number().int().positive().nullish(),
  part: z.number().int().min(1).nullish(),
});

/**
 * Normalize empty strings to null for database storage.
 * This is a safety net for direct API calls - the client already
 * converts empty strings to null before sending.
 */
function normalizeEmptyToNull<T>(value: T): T | null {
  if (value === "") return null;
  return value;
}

async function findCatalogEntry(catalogId: string, hash: string) {
  return prisma.catalogEntry.findUnique({
    where: {
      workflowGroupId_audioHash: {
        workflowGroupId: catalogId,
        audioHash: hash,
      },
    },
    select: { audioHash: true },
  });
}

/**
 * GET /api/catalogs/:id/recordings/:hash/metadata - Get curated metadata for a recording
 *
 * Returns curated metadata if it exists, or null if not yet curated.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;
    const userId = await requireAuth();

    const capability = await getRecordingCapability(catalogId, hash, userId);
    if (!capability.catalogExists) {
      return notFound("catalog");
    }

    if (!capability.hasAccess) {
      await logAccessDenied(userId, "metadata-read", hash, { catalogId });
      return forbidden("Access denied");
    }

    const entry = await findCatalogEntry(catalogId, hash);
    if (!entry) {
      return notFound("recording");
    }

    if (!capability.canAccessRecording) {
      await logAccessDenied(userId, "metadata-read", hash, {
        catalogId,
        reason: "Recording is not published for listeners",
      });
      return notFound("recording");
    }

    const metadata = await prisma.audioMetadata.findUnique({
      where: {
        workflowGroupId_audioHash: {
          workflowGroupId: catalogId,
          audioHash: hash,
        },
      },
      include: {
        recorder: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
        album: { select: { id: true, name: true } },
      },
    });

    if (!metadata) {
      return NextResponse.json({ hash, curated: false });
    }

    return NextResponse.json({
      hash,
      curated: true,
      ...metadata,
    });
  } catch (error) {
    return handlePrismaError(error, "metadata", "fetch");
  }
}

/**
 * PUT /api/catalogs/:id/recordings/:hash/metadata - Create or update curated metadata for a recording
 *
 * Body:
 * - title, artist, album: Optional strings
 * - dateYear, dateMonth, dateDay: Optional integers for date
 * - notes: Optional string
 * - tags: Optional string array
 * - verified: Optional boolean
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, RecordingMetadataBodySchema);
    if (!bodyResult.success) return bodyResult.response;
    const {
      title,
      artist,
      albumId,
      dateYear,
      dateMonth,
      dateDay,
      notes,
      tags,
      verified,
      recorderId,
      locationId,
      part,
    } = bodyResult.data;

    const userId = await requireAuth();

    const capability = await getRecordingCapability(catalogId, hash, userId);
    if (!capability.catalogExists) {
      return notFound("catalog");
    }

    if (!capability.hasAccess || !capability.canEditRecording) {
      await logAccessDenied(userId, "metadata", hash, {
        catalogId,
        action: "edit",
      });
      return forbidden("You don't have permission to edit metadata");
    }

    const entry = await findCatalogEntry(catalogId, hash);
    if (!entry) {
      return notFound("recording");
    }

    // Build update data - only include fields that were explicitly provided
    // Normalize empty strings to null for consistent database storage
    const updateData: Record<string, unknown> = {};
    if (title !== undefined) updateData.title = normalizeEmptyToNull(title);
    if (artist !== undefined) updateData.artist = normalizeEmptyToNull(artist);
    if (albumId !== undefined) updateData.albumId = normalizeEmptyToNull(albumId);
    if (dateYear !== undefined) updateData.dateYear = dateYear;
    if (dateMonth !== undefined) updateData.dateMonth = dateMonth;
    if (dateDay !== undefined) updateData.dateDay = dateDay;
    if (notes !== undefined) updateData.notes = normalizeEmptyToNull(notes);
    if (tags !== undefined) updateData.tags = tags;
    if (recorderId !== undefined) updateData.recorderId = normalizeEmptyToNull(recorderId);
    if (locationId !== undefined) updateData.locationId = normalizeEmptyToNull(locationId);
    if (part !== undefined) updateData.part = part;
    if (verified !== undefined) {
      updateData.verified = verified;
      updateData.verifiedAt = verified ? new Date() : null;
      updateData.verifiedBy = verified ? userId : null;
    }

    // Fetch existing metadata to detect changes for audit logging
    const existingMetadata = await prisma.audioMetadata.findUnique({
      where: {
        workflowGroupId_audioHash: {
          workflowGroupId: catalogId,
          audioHash: hash,
        },
      },
      select: { verified: true },
    });

    // Build create data with same normalization
    const createData: Record<string, unknown> = {
      workflowGroupId: catalogId,
      audioHash: hash,
      tags: tags ?? [],
      verified: verified ?? false,
    };
    if (title !== undefined) createData.title = normalizeEmptyToNull(title);
    if (artist !== undefined) createData.artist = normalizeEmptyToNull(artist);
    if (albumId !== undefined) createData.albumId = normalizeEmptyToNull(albumId);
    if (dateYear !== undefined) createData.dateYear = dateYear;
    if (dateMonth !== undefined) createData.dateMonth = dateMonth;
    if (dateDay !== undefined) createData.dateDay = dateDay;
    if (notes !== undefined) createData.notes = normalizeEmptyToNull(notes);
    if (recorderId !== undefined) createData.recorderId = normalizeEmptyToNull(recorderId);
    if (locationId !== undefined) createData.locationId = normalizeEmptyToNull(locationId);
    if (part !== undefined) createData.part = part;
    if (verified) {
      createData.verifiedAt = new Date();
      createData.verifiedBy = userId;
    }

    // Upsert metadata
    const metadata = await prisma.audioMetadata.upsert({
      where: {
        workflowGroupId_audioHash: {
          workflowGroupId: catalogId,
          audioHash: hash,
        },
      },
      update: updateData,
      create: createData as Parameters<typeof prisma.audioMetadata.create>[0]["data"],
      include: {
        recorder: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
        album: { select: { id: true, name: true } },
      },
    });

    // Update catalog timestamp to trigger change detection for offline sync
    await prisma.workflowGroup.update({
      where: { id: catalogId },
      data: { updatedAt: new Date() },
    });

    // Audit logging
    const metadataFields = ['title', 'artist', 'albumId', 'dateYear', 'dateMonth', 'dateDay', 'notes', 'tags', 'recorderId', 'locationId', 'part'];
    const changedFields = metadataFields.filter(field => field in updateData);

    // Log verification status change separately
    if (verified !== undefined && verified !== (existingMetadata?.verified ?? false)) {
      await logMetadataVerified(userId!, hash, catalogId, verified);
    }

    // Log other metadata changes
    if (changedFields.length > 0) {
      await logMetadataUpdated(userId!, hash, catalogId, changedFields);
    }

    return NextResponse.json({
      hash,
      curated: true,
      ...metadata,
    });
  } catch (error) {
    return handlePrismaError(error, "metadata", "update");
  }
}

/**
 * DELETE /api/catalogs/:id/recordings/:hash/metadata - Delete curated metadata for a recording
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;
    const userId = await requireAuth();

    const capability = await getRecordingCapability(catalogId, hash, userId);
    if (!capability.catalogExists) {
      return notFound("catalog");
    }

    if (!capability.hasAccess || !capability.canEditRecording) {
      await logAccessDenied(userId, "metadata", hash, {
        catalogId,
        action: "delete",
      });
      return forbidden("You don't have permission to delete metadata");
    }

    const entry = await findCatalogEntry(catalogId, hash);
    if (!entry) {
      return notFound("recording");
    }

    await prisma.audioMetadata.delete({
      where: {
        workflowGroupId_audioHash: {
          workflowGroupId: catalogId,
          audioHash: hash,
        },
      },
    });

    // Update catalog timestamp to trigger change detection for offline sync
    await prisma.workflowGroup.update({
      where: { id: catalogId },
      data: { updatedAt: new Date() },
    });

    // Audit log metadata deletion
    await logContentEvent({
      action: "METADATA_DELETED",
      actorId: userId!,
      resource: "metadata",
      resourceId: hash,
      catalogId,
      subjectType: "metadata",
      payload: { catalogId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handlePrismaError(error, "metadata", "delete");
  }
}
