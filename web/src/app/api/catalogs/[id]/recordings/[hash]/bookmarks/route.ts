import { NextRequest, NextResponse } from 'next/server';
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
import {
  bookmarkSelect,
  createBookmarkBodySchema,
  serializeBookmark,
} from '@/lib/bookmarks/schemas';
import { CatalogHashParamSchema } from '@/lib/validation/schemas';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

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
    auditResource: 'recording_bookmark',
    deniedMessage: 'Recording not found in catalog',
    reason: 'Recording is not accessible',
    status: 404,
  });
  if (denied) return { response: denied } as const;
  return { access } as const;
}

/** The current user's bookmarks in this recording, in playback order. */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const resolved = await resolveAccess(params);
    if ('response' in resolved) return resolved.response;
    const { userId, catalogId, hash } = resolved.access;
    const bookmarks = await prisma.recordingBookmark.findMany({
      where: { userId, workflowGroupId: catalogId, audioHash: hash },
      orderBy: [{ positionSec: 'asc' }, { createdAt: 'asc' }],
      select: bookmarkSelect,
    });

    return NextResponse.json({ bookmarks: bookmarks.map(serializeBookmark) });
  } catch (error) {
    return handlePrismaError(error, 'bookmark', 'fetch');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;
    const resolved = await resolveAccess(params);
    if ('response' in resolved) return resolved.response;
    const bodyResult = await validateRequestBody(
      request,
      createBookmarkBodySchema,
    );
    if (!bodyResult.success) return bodyResult.response;

    const { userId, catalogId, hash } = resolved.access;
    const bookmark = await prisma.recordingBookmark.create({
      data: {
        userId,
        workflowGroupId: catalogId,
        audioHash: hash,
        ...bodyResult.data,
      },
      select: bookmarkSelect,
    });

    return NextResponse.json(
      { bookmark: serializeBookmark(bookmark) },
      { status: 201 },
    );
  } catch (error) {
    return handlePrismaError(error, 'bookmark', 'create');
  }
}
