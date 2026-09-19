import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import {
  conflict,
  handlePrismaError,
  notFound,
  validateMutationSource,
  validateParams,
} from '@/lib/api';
import { requireAdminCapability } from '@/lib/access/require-admin';
import { logContentEvent } from '@/lib/audit/logger';
import { ingestJobSchema } from '@/lib/jobs-api/schemas';
import { fetchJobsApi } from '@/lib/jobs-api/server';
import { CuidSchema } from '@/lib/validation/schemas';
import {
  AcceptedIntakeIdentityError,
  INTAKE_INCLUDE,
  recoverAcceptedIntakeAudioHash,
  removeAllIntakeDirs,
  serializeIntake,
} from '@/lib/ingest/server';
import { isRemovableIntakeStatus } from '@/lib/ingest/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IntakeParamSchema = z.object({ intakeId: CuidSchema });
const JobIdSchema = z.string().uuid();

interface RouteParams {
  params: Promise<{ intakeId: string }>;
}

/**
 * POST /api/admin/ingest/:intakeId/remove
 * Removes an ingested recording and everything derived from it.
 *
 * A recording that reached the catalog (SUCCEEDED, or FAILED after the file was
 * accepted) is removed by the host worker through the `remove_recording_flow`;
 * the web side finishes the job in the completion callback. Intakes that never
 * touched the catalog (REJECTED duplicates, early failures, cancellations) only
 * have upload files to clean up, which happens here directly.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const { userId } = await requireAdminCapability({
      message: 'Unauthorized',
    });

    const paramsResult = validateParams(await params, IntakeParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { intakeId } = paramsResult.data;

    const intake = await prisma.recordingIntake.findUnique({
      where: { id: intakeId },
      include: INTAKE_INCLUDE,
    });
    if (!intake) return notFound('intake');
    if (!isRemovableIntakeStatus(intake.status)) {
      return conflict('Only finished intakes can be removed');
    }

    let removalHash = intake.audioHash;
    if (removalHash === null) {
      try {
        removalHash = await recoverAcceptedIntakeAudioHash(
          intake.workflowGroupId,
          intake.id,
        );
      } catch (error) {
        if (error instanceof AcceptedIntakeIdentityError) {
          return conflict(`${error.message}; nothing was deleted`);
        }
        throw error;
      }
    }

    // A REJECTED intake's hash points at the *existing* recording it duplicated;
    // that one must never be removed from here. CANCELLED intakes with a stored or
    // recovered hash may have reached catalog_add, so run the idempotent catalog
    // cleanup rather than deleting only the source directory it may reference.
    const reachedCatalog =
      removalHash !== null &&
      (intake.status === 'SUCCEEDED' ||
        intake.status === 'FAILED' ||
        intake.status === 'CANCELLED');

    if (!reachedCatalog) {
      await removeAllIntakeDirs(intake.workflowGroupId, intake.id);
      await prisma.recordingIntake.updateMany({
        where: { id: intake.id, status: intake.status },
        data: { status: 'REMOVED', finishedAt: new Date() },
      });
      const removed = await prisma.recordingIntake.findUniqueOrThrow({
        where: { id: intake.id },
        include: INTAKE_INCLUDE,
      });
      await logContentEvent({
        action: 'RECORDING_INGEST_REMOVED',
        actorId: userId,
        resource: 'recording_intake',
        resourceId: intake.id,
        catalogId: intake.workflowGroupId,
        catalogLabel: intake.workflowGroup?.label ?? null,
        payload: { title: intake.originalFilename, mode: 'files_only' },
      });
      return NextResponse.json({ intake: serializeIntake(removed) });
    }

    const audioHash = removalHash;
    let jobId: string;
    try {
      const job = await fetchJobsApi(
        `/catalogs/${encodeURIComponent(intake.workflowGroupId)}/ingest/removals`,
        {
          method: 'POST',
          body: {
            intakeId: intake.id,
            audioHash,
            requestedById: userId,
            idempotencyKey: intake.jobId ?? intake.id,
          },
          schema: ingestJobSchema,
        },
      );
      jobId = JobIdSchema.parse(job.id);
    } catch (error) {
      console.error('Failed to submit ingest removal job:', error);
      return NextResponse.json(
        {
          error: 'Removal job could not be submitted; nothing was changed',
          retryable: true,
        },
        { status: 502 },
      );
    }

    await prisma.recordingIntake.updateMany({
      where: { id: intake.id, status: intake.status },
      data: {
        status: 'REMOVING',
        jobId,
        audioHash,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
      },
    });
    const removing = await prisma.recordingIntake.findUniqueOrThrow({
      where: { id: intake.id },
      include: INTAKE_INCLUDE,
    });

    await logContentEvent({
      action: 'RECORDING_INGEST_REMOVED',
      actorId: userId,
      resource: 'recording_intake',
      resourceId: intake.id,
      catalogId: intake.workflowGroupId,
      catalogLabel: intake.workflowGroup?.label ?? null,
      payload: {
        title: intake.originalFilename,
        audioHash,
        jobId,
        mode: 'catalog',
      },
    });

    return NextResponse.json({ intake: serializeIntake(removing) });
  } catch (error) {
    return handlePrismaError(error, 'recording ingest removal', 'create');
  }
}
