import { NextResponse } from 'next/server';
import { handlePrismaError } from '@/lib/api';
import { requireAuth } from '@/lib/auth/permissions';
import { listUserBookmarks } from '@/lib/bookmarks/list';

export const dynamic = 'force-dynamic';

/** Every bookmark of the current user in a recording they can still open. */
export async function GET() {
  try {
    const userId = await requireAuth();
    return NextResponse.json({ bookmarks: await listUserBookmarks(userId) });
  } catch (error) {
    return handlePrismaError(error, 'bookmark', 'fetch');
  }
}
