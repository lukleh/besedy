import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import prisma from '@/lib/db';
import {
  badRequest,
  conflict,
  handlePrismaError,
  notFound,
  validateMutationSource,
  validateParams,
} from '@/lib/api';
import { requireAdminCapability } from '@/lib/access/require-admin';
import { logContentEvent } from '@/lib/audit/logger';
import { ingestJobSchema } from '@/lib/jobs-api/schemas';
import { fetchJobsApi, JobsApiError } from '@/lib/jobs-api/server';
import { CuidSchema } from '@/lib/validation/schemas';
import {
  INTAKE_INCLUDE,
  removeIntakeDir,
  resolveIntakeChunkPath,
  resolveIntakeFilePath,
  serializeIntake,
} from '@/lib/ingest/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IntakeParamSchema = z.object({ intakeId: CuidSchema });
const JobIdSchema = z.string().uuid();

interface RouteParams {
  params: Promise<{ intakeId: string }>;
}

async function assembleUpload(intake: {
  workflowGroupId: string;
  id: string;
  storedFilename: string;
  expectedSizeBytes: bigint;
  receivedChunks: number;
}): Promise<void> {
  const filePath = resolveIntakeFilePath(intake);
  const existing = await fs.stat(filePath).catch(() => null);
  if (existing) {
    if (BigInt(existing.size) !== intake.expectedSizeBytes) {
      throw new Error('Existing assembled upload has the wrong size');
    }
    return;
  }

  const tempPath = path.join(
    /* turbopackIgnore: true */
    path.dirname(filePath),
    `.${intake.storedFilename}.${randomUUID()}`,
  );
  let assembledBytes = 0;
  try {
    for (let index = 0; index < intake.receivedChunks; index += 1) {
      const chunkPath = resolveIntakeChunkPath(intake, index);
      const chunk = await fs.lstat(chunkPath);
      if (!chunk.isFile() || chunk.size <= 0) {
        throw new Error(`Upload chunk ${index} is invalid`);
      }
      assembledBytes += chunk.size;
      if (BigInt(assembledBytes) > intake.expectedSizeBytes) {
        throw new Error('Upload chunks exceed the declared size');
      }
      await pipeline(
        createReadStream(chunkPath),
        createWriteStream(tempPath, { flags: index === 0 ? 'wx' : 'a' }),
      );
    }
    if (BigInt(assembledBytes) !== intake.expectedSizeBytes) {
      throw new Error('Upload chunks do not match the declared size');
    }
    try {
      await fs.link(tempPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = await fs.stat(filePath);
      if (BigInt(raced.size) !== intake.expectedSizeBytes) {
        throw new Error('Concurrent upload assembly produced the wrong size');
      }
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * POST /api/admin/ingest/uploads/:intakeId/finalize
 * Verifies the upload is complete and submits the ingest job to the jobs API.
 *
 * Only a definite rejection by the jobs API (4xx) discards the upload. Any
 * other failure (jobs API unreachable, misconfigured, or an unparseable
 * response after the run may already exist) keeps the file and the UPLOADING
 * row so the submit can be retried, and a worker that did pick up the run can
 * still complete it.
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
    if (intake.status !== 'UPLOADING') {
      return conflict('Upload has already been submitted');
    }
    if (intake.receivedBytes !== intake.expectedSizeBytes) {
      return badRequest('Upload incomplete', {
        receivedBytes: Number(intake.receivedBytes),
        expectedSizeBytes: Number(intake.expectedSizeBytes),
      });
    }

    try {
      await assembleUpload(intake);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Upload assembly failed';
      return badRequest(message);
    }

    const onDisk = await fs
      .stat(resolveIntakeFilePath(intake))
      .catch(() => null);
    if (!onDisk || BigInt(onDisk.size) !== intake.expectedSizeBytes) {
      return badRequest('Uploaded file size does not match the declared size');
    }

    let jobId: string;
    try {
      const job = await fetchJobsApi(
        `/catalogs/${encodeURIComponent(intake.workflowGroupId)}/ingest/jobs`,
        {
          method: 'POST',
          body: {
            intakeId: intake.id,
            originalFilename: intake.originalFilename,
            requestedById: userId,
          },
          schema: ingestJobSchema,
        },
      );
      jobId = JobIdSchema.parse(job.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to submit ingest job';
      console.error('Failed to submit ingest job:', error);

      const rejected =
        error instanceof JobsApiError &&
        error.status >= 400 &&
        error.status < 500;
      if (!rejected) {
        return NextResponse.json(
          {
            error:
              'Ingest job could not be submitted; the upload was kept for retry',
            retryable: true,
          },
          { status: 502 },
        );
      }

      const failed = await prisma.recordingIntake.update({
        where: { id: intake.id },
        data: {
          status: 'FAILED',
          errorCode: 'submit_failed',
          errorMessage: message.slice(0, 2000),
          finishedAt: new Date(),
        },
        include: INTAKE_INCLUDE,
      });
      await removeIntakeDir(intake.workflowGroupId, intake.id);
      return NextResponse.json(
        {
          error: 'Failed to submit ingest job',
          intake: serializeIntake(failed),
        },
        { status: 502 },
      );
    }

    // Guarded: a fast worker may already have reported completion for this
    // intake; never overwrite a terminal status with QUEUED.
    await prisma.recordingIntake.updateMany({
      where: { id: intake.id, status: 'UPLOADING' },
      data: { status: 'QUEUED', jobId },
    });
    const queued = await prisma.recordingIntake.findUniqueOrThrow({
      where: { id: intake.id },
      include: INTAKE_INCLUDE,
    });

    await logContentEvent({
      action: 'RECORDING_INGEST_REQUESTED',
      actorId: userId,
      resource: 'recording_intake',
      resourceId: intake.id,
      catalogId: intake.workflowGroupId,
      catalogLabel: intake.workflowGroup?.label ?? null,
      payload: {
        title: intake.originalFilename,
        sizeBytes: Number(intake.expectedSizeBytes),
        jobId,
      },
    });

    return NextResponse.json({ intake: serializeIntake(queued) });
  } catch (error) {
    return handlePrismaError(error, 'recording ingest upload', 'update');
  }
}
