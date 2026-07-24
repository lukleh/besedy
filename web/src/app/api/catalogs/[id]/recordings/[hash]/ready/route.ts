import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { isRecordingInReleasedEvent } from "@/lib/catalog-events/publication";
import { requireCatalogManagementAccess } from "@/lib/access/catalog-management-route-access";
import {
  logCatalogPublicationEvent,
} from "@/lib/audit/logger";
import { canPublishRecording } from "@/lib/policy/recording";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import {
  badRequest,
  handlePrismaError,
  validateParams,
  validateRequestBody,
} from "@/lib/api";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

const RecordingPublicationBodySchema = z.object({
  isPublished: z.boolean(),
});

type PatchRecordingPublicationResult =
  | { kind: "updated"; audioHash: string; isPublished: boolean }
  | { kind: "unchanged"; isPublished: boolean }
  | { kind: "recording_not_found" }
  | { kind: "bad_request"; message: string };

/**
 * PATCH /api/catalogs/:id/recordings/:hash/ready
 * Owner/Admin-only manual publication toggle for LISTENER visibility.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const bodyResult = await validateRequestBody(
      request,
      RecordingPublicationBodySchema
    );
    if (!bodyResult.success) return bodyResult.response;
    const { isPublished } = bodyResult.data;

    const access = await requireCatalogManagementAccess(catalogId, {
      auditResource: "catalog_publication",
      auditResourceId: hash,
      deniedMessage: "Only owner/admin can update publication state",
      deniedReason: "Only owner/admin can update publication state",
      authorize: canPublishRecording,
    });
    if (!access.ok) {
      return access.response;
    }
    const { userId } = access;

    const result = await prisma.$transaction<PatchRecordingPublicationResult>(async (tx) => {
      await tx.$queryRaw`
        SELECT audio_hash
        FROM catalog_entry
        WHERE workflow_group_id = ${catalogId}
          AND audio_hash = ${hash}
        FOR UPDATE
      `;

      const entry = await tx.catalogEntry.findUnique({
        where: {
          workflowGroupId_audioHash: {
            workflowGroupId: catalogId,
            audioHash: hash,
          },
        },
        select: {
          audioHash: true,
          isActionable: true,
          isPublished: true,
        },
      });
      if (!entry) {
        return { kind: "recording_not_found" };
      }

      const inReleasedEvent = !isPublished
        ? await isRecordingInReleasedEvent(tx, catalogId, hash)
        : false;

      if (isPublished && !entry.isActionable) {
        return { kind: "bad_request", message: "Cannot publish an incomplete recording" };
      }
      if (inReleasedEvent) {
        return {
          kind: "bad_request",
          message: "Cannot unpublish a recording that belongs to a released event",
        };
      }

      if (entry.isPublished === isPublished) {
        return {
          kind: "unchanged",
          isPublished: entry.isPublished,
        };
      }

      const updated = await tx.catalogEntry.update({
        where: {
          workflowGroupId_audioHash: {
            workflowGroupId: catalogId,
            audioHash: hash,
          },
        },
        data: { isPublished },
        select: {
          audioHash: true,
          isPublished: true,
        },
      });

      await tx.workflowGroup.update({
        where: { id: catalogId },
        data: { updatedAt: new Date() },
      });

      return {
        kind: "updated",
        audioHash: updated.audioHash,
        isPublished: updated.isPublished,
      };
    });

    if (result.kind === "recording_not_found") {
      return NextResponse.json({ error: "Recording not found" }, { status: 404 });
    }
    if (result.kind === "bad_request") {
      return badRequest(result.message);
    }
    if (result.kind === "unchanged") {
      return NextResponse.json({
        hash,
        isPublished: result.isPublished,
      });
    }

    await logCatalogPublicationEvent({
      actorId: userId,
      audioHash: hash,
      catalogId,
      isPublished,
    });

    return NextResponse.json({
      hash: result.audioHash,
      isPublished: result.isPublished,
    });
  } catch (error) {
    return handlePrismaError(error, "recording publication", "update");
  }
}
