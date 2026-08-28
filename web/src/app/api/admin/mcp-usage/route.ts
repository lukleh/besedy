import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/permissions';
import { handlePrismaError } from '@/lib/api';
import { requireAdminCapability } from '@/lib/access/require-admin';
import {
  getMcpUsageAnalytics,
  parseMcpUsageRange,
} from '@/lib/mcp/usage-analytics';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: 'Admin access required' });
    const range = parseMcpUsageRange(request.nextUrl.searchParams.get('range'));
    return NextResponse.json(await getMcpUsageAnalytics(range));
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    return handlePrismaError(error, 'MCP usage analytics', 'fetch');
  }
}
