import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAnalytics: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/access/require-admin', () => ({
  requireAdminCapability: mocks.requireAdmin,
}));

vi.mock('@/lib/mcp/usage-analytics', () => ({
  parseMcpUsageRange: (value: string | null) =>
    value === '24h' ? '24h' : '7d',
  getMcpUsageAnalytics: mocks.getAnalytics,
}));

import { GET } from '@/app/api/admin/mcp-usage/route';

describe('admin MCP usage route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1' });
    mocks.getAnalytics.mockResolvedValue({
      range: '24h',
      summary: { totalCalls: 3 },
    });
  });

  it('requires admin access and returns the requested analytics range', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/admin/mcp-usage?range=24h'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      range: '24h',
      summary: { totalCalls: 3 },
    });
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      message: 'Admin access required',
    });
    expect(mocks.getAnalytics).toHaveBeenCalledWith('24h');
  });
});
