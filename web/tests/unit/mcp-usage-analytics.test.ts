import { describe, expect, it } from 'vitest';
import {
  getMcpUsagePeriodStart,
  parseMcpUsageRange,
} from '@/lib/mcp/usage-analytics';

describe('MCP usage analytics ranges', () => {
  it('accepts supported ranges and falls back to seven days', () => {
    expect(parseMcpUsageRange('24h')).toBe('24h');
    expect(parseMcpUsageRange('30d')).toBe('30d');
    expect(parseMcpUsageRange('12m')).toBe('12m');
    expect(parseMcpUsageRange('unexpected')).toBe('7d');
    expect(parseMcpUsageRange(null)).toBe('7d');
  });

  it('includes the 12-month boundary day without mutating the supplied date', () => {
    const now = new Date('2026-08-28T18:00:00.000Z');

    expect(getMcpUsagePeriodStart('24h', now).toISOString()).toBe(
      '2026-08-27T18:00:00.000Z',
    );
    expect(getMcpUsagePeriodStart('7d', now).toISOString()).toBe(
      '2026-08-21T18:00:00.000Z',
    );
    expect(getMcpUsagePeriodStart('30d', now).toISOString()).toBe(
      '2026-07-29T18:00:00.000Z',
    );
    expect(getMcpUsagePeriodStart('12m', now).toISOString()).toBe(
      '2025-08-28T00:00:00.000Z',
    );
    expect(now.toISOString()).toBe('2026-08-28T18:00:00.000Z');
  });

  it('clamps a leap-day boundary to the last day of February', () => {
    const now = new Date('2028-02-29T18:00:00.000Z');

    expect(getMcpUsagePeriodStart('12m', now).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
    expect(now.toISOString()).toBe('2028-02-29T18:00:00.000Z');
  });
});
