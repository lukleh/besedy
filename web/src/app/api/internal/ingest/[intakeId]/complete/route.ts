import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import {
  handlePrismaError,
  notFound,
  validateParams,
  validateRequestBody,
} from '@/lib/api';
import { syncCatalogGroup, type CatalogSyncResult } from '@/lib/catalog-sync';
import { authorizeJobServiceRequest } from '@/lib/security/job-service-auth';
import { CuidSchema, HashSchema } from '@/lib/validation/schemas';
import { removeRecordingWebState } from '@/lib/ingest/removal';
import { INTAKE_INCLUDE, serializeIntake } from '@/lib/ingest/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IntakeParamSchema = z.object({ intakeId: CuidSchema });

const CompletionSchema = z.object({
  status: z.enum(['SUCCEEDED', 'REJECTED', 'FAILED', 'REMOVED']),
  audioHash: HashSchema.nullable().optional(),
  errorCode: z.string().trim().max(100).nullable().optional(),
  errorMessage: z.string().trim().max(4000).nullable().optional(),
});

const TERMINAL_STATUSES = new Set([
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
  'REMOVED',
]);

interface RouteParams {
  params: Promise<{ intakeId: string }>;
}

/**
 * POST /api/internal/ingest/:intakeId/complete
 * Called by the host ingest worker when a flow run finishes. On success the
 * catalog projection is re-synced so the new recording appears immediately; on
 * REMOVED the web-owned rows for the recording are deleted before the re-sync.
 * Idempotent: a terminal intake accepts repeated reports without re-syncing.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authError = authorizeJobServiceRequest(request);
    if (authError) return authError;

    const paramsResult = validateParams(await params, IntakeParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { intakeId } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, CompletionSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { status, audioHash, errorCode, errorMessage } = bodyResult.data;

    const intake = await prisma.recordingIntake.findUnique({
      where: { id: intakeId },
      include: INTAKE_INCLUDE,
    });
    if (!intake) return notFound('intake');

    if (TERMINAL_STATUSES.has(intake.status)) {
      return NextResponse.json({
        ok: true,
        alreadyFinal: true,
        intake: serializeIntake(intake),
      });
    }

    // Finish side effects before making the intake terminal. If cleanup or
    // sync throws, the worker's retry sees the active row and safely retries
    // the idempotent work instead of treating a half-finished removal as done.
    const resolvedHash = audioHash ? audioHash.toLowerCase() : intake.audioHash;
    let sync: CatalogSyncResult | null = null;
    let removal = null;
    if (status === 'REMOVED') {
      if (resolvedHash) {
        removal = await removeRecordingWebState(
          intake.workflowGroupId,
          resolvedHash,
        );
      }
      sync = await syncCatalogGroup(intake.workflowGroupId);
    }
    if (status === 'SUCCEEDED') {
      sync = await syncCatalogGroup(intake.workflowGroupId);
    }

    const syncError =
      sync?.status === 'error'
        ? `Catalog sync failed: ${sync.error ?? 'unknown error'}`
        : null;
    const resolvedErrorMessage = [errorMessage, syncError]
      .filter((message): message is string => Boolean(message))
      .join('\n')
      .slice(0, 4000);
    const updated = await prisma.recordingIntake.update({
      where: { id: intake.id },
      data: {
        status,
        audioHash:
          status === 'REMOVED' || status === 'FAILED'
            ? resolvedHash
            : audioHash
              ? audioHash.toLowerCase()
              : null,
        errorCode: syncError ? 'sync_failed' : (errorCode ?? null),
        errorMessage: resolvedErrorMessage || null,
        finishedAt: new Date(),
      },
      include: INTAKE_INCLUDE,
    });

    return NextResponse.json({
      ok: sync ? sync.status !== 'error' : true,
      alreadyFinal: false,
      intake: serializeIntake(updated),
      sync,
      removal,
    });
  } catch (error) {
    return handlePrismaError(error, 'recording ingest completion', 'update');
  }
}
