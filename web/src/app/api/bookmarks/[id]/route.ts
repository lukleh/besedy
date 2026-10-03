import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import {
  handlePrismaError,
  notFound,
  validateMutationSource,
  validateParams,
  validateRequestBody,
} from '@/lib/api';
import { requireAuth } from '@/lib/auth/permissions';
import {
  BookmarkIdParamSchema,
  bookmarkSelect,
  serializeBookmark,
  updateBookmarkBodySchema,
} from '@/lib/bookmarks/schemas';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// A bookmark is private: only its owner can change or delete it, and another
// user's bookmark answers as missing. Neither needs the recording to still be
// accessible, so a listener can always clear out what they made.

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;
    const userId = await requireAuth();
    const paramsResult = validateParams(await params, BookmarkIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const bodyResult = await validateRequestBody(
      request,
      updateBookmarkBodySchema,
    );
    if (!bodyResult.success) return bodyResult.response;

    // Another user's bookmark matches nothing, and Prisma's not-found error
    // answers 404 through handlePrismaError.
    const bookmark = await prisma.recordingBookmark.update({
      where: { id: paramsResult.data.id, userId },
      data: { comment: bodyResult.data.comment },
      select: bookmarkSelect,
    });

    return NextResponse.json({ bookmark: serializeBookmark(bookmark) });
  } catch (error) {
    return handlePrismaError(error, 'bookmark', 'update');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;
    const userId = await requireAuth();
    const paramsResult = validateParams(await params, BookmarkIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;

    const deleted = await prisma.recordingBookmark.deleteMany({
      where: { id: paramsResult.data.id, userId },
    });
    if (deleted.count === 0) return notFound('bookmark');

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handlePrismaError(error, 'bookmark', 'delete');
  }
}
