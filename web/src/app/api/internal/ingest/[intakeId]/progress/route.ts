import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import {
  handlePrismaError,
  notFound,
  validateParams,
  validateRequestBody,
} from '@/lib/api';
import { authorizeJobServiceRequest } from '@/lib/security/job-service-auth';
import { CuidSchema } from '@/lib/validation/schemas';
import { ACTIVE_INTAKE_STATUSES } from '@/lib/ingest/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PROGRESS_LABEL_LENGTH = 200;

const IntakeParamSchema = z.object({ intakeId: CuidSchema });

const ProgressSchema = z.object({
  step: z.number().int().min(0).max(1000).nullable().optional(),
  total: z.number().int().min(0).max(1000).nullable().optional(),
  label: z.string().trim().min(1).max(4000),
});

interface RouteParams {
  params: Promise<{ intakeId: string }>;
}

/**
 * POST /api/internal/ingest/:intakeId/progress
 * Called by the host ingest worker when a run reaches a new step. Display
 * only: it records the step on an active intake and never changes its status.
 * Reports for an intake that is no longer active are acknowledged and ignored.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authError = authorizeJobServiceRequest(request);
    if (authError) return authError;

    const paramsResult = validateParams(await params, IntakeParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { intakeId } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, ProgressSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { step, total, label } = bodyResult.data;

    const intake = await prisma.recordingIntake.findUnique({
      where: { id: intakeId },
      select: { startedAt: true },
    });
    if (!intake) return notFound('intake');

    const now = new Date();
    const result = await prisma.recordingIntake.updateMany({
      where: { id: intakeId, status: { in: [...ACTIVE_INTAKE_STATUSES] } },
      data: {
        progressStep: step ?? null,
        progressTotal: total ?? null,
        progressLabel: label.slice(0, MAX_PROGRESS_LABEL_LENGTH),
        progressStepStartedAt: now,
        ...(intake.startedAt ? {} : { startedAt: now }),
      },
    });

    return NextResponse.json({ ok: true, applied: result.count > 0 });
  } catch (error) {
    return handlePrismaError(error, 'recording ingest progress', 'update');
  }
}
