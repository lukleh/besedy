import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import {
  type CatalogRecordingRouteAccessContext,
  requireCatalogRecordingAccess,
  resolveCatalogRecordingRouteAccess,
} from '@/lib/access/catalog-recording-route-access';
import {
  handlePrismaError,
  validateMutationSource,
  validateParams,
  validateRequestBody,
} from '@/lib/api';
import { CatalogHashParamSchema } from '@/lib/validation/schemas';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

const playbackProgressBodySchema = z.object({
  positionSec: z
    .number()
    .finite()
    .min(0)
    .max(60 * 60 * 24 * 30),
  durationSec: z
    .number()
    .finite()
    .positive()
    .max(60 * 60 * 24 * 30)
    .nullable(),
  completed: z.boolean().optional().default(false),
});

async function resolveAccess(
  params: RouteParams['params'],
): Promise<
  { response: NextResponse } | { access: CatalogRecordingRouteAccessContext }
> {
  const paramsResult = validateParams(await params, CatalogHashParamSchema);
  if (!paramsResult.success)
    return { response: paramsResult.response } as const;
  const { id: catalogId, hash } = paramsResult.data;
  const access = await resolveCatalogRecordingRouteAccess(catalogId, hash);
  if (!access.ok) return { response: access.response } as const;
  const denied = await requireCatalogRecordingAccess(access, {
    auditResource: 'recording_playback_progress',
    deniedMessage: 'Recording not found in catalog',
    reason: 'Recording is not accessible',
    status: 404,
  });
  if (denied) return { response: denied } as const;
  return { access } as const;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const resolved = await resolveAccess(params);
    if ('response' in resolved) return resolved.response;
    const { userId, hash } = resolved.access;
    const progress = await prisma.recordingPlaybackProgress.findUnique({
      where: { userId_audioHash: { userId, audioHash: hash } },
      select: {
        positionSec: true,
        durationSec: true,
        completedAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      progress: progress
        ? {
            ...progress,
            completed: progress.completedAt !== null,
            completedAt: progress.completedAt?.toISOString() ?? null,
            updatedAt: progress.updatedAt.toISOString(),
          }
        : null,
    });
  } catch (error) {
    return handlePrismaError(error, 'recording playback progress', 'fetch');
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;
    const resolved = await resolveAccess(params);
    if ('response' in resolved) return resolved.response;
    const bodyResult = await validateRequestBody(
      request,
      playbackProgressBodySchema,
    );
    if (!bodyResult.success) return bodyResult.response;

    const { userId, hash } = resolved.access;
    const durationSec = bodyResult.data.durationSec;
    const positionSec = durationSec
      ? Math.min(bodyResult.data.positionSec, durationSec)
      : bodyResult.data.positionSec;
    const completed = bodyResult.data.completed;
    const now = new Date();
    const progress = await prisma.recordingPlaybackProgress.upsert({
      where: { userId_audioHash: { userId, audioHash: hash } },
      create: {
        userId,
        audioHash: hash,
        positionSec,
        durationSec,
        completedAt: completed ? now : null,
      },
      update: {
        positionSec,
        durationSec: durationSec ?? undefined,
        completedAt: completed ? now : undefined,
      },
      select: { positionSec: true, durationSec: true, completedAt: true },
    });

    return NextResponse.json({
      progress: { ...progress, completed: progress.completedAt !== null },
    });
  } catch (error) {
    return handlePrismaError(error, 'recording playback progress', 'update');
  }
}
