import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ingestResultRecordSchema } from '@/lib/jobs-api/schemas';

const records = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../contracts/job-records.json'),
    'utf-8',
  ),
) as Array<Record<string, unknown>>;

describe('ingest result records', () => {
  it('accepts the Python writer contract examples', () => {
    for (const record of records.filter((record) => record.kind === 'result')) {
      expect(ingestResultRecordSchema.parse(record)).toEqual(record);
    }
  });

  it('rejects prose, unknown versions and invalid terminal payloads', () => {
    const record = records.find((record) => record.kind === 'result')!;
    for (const input of [
      'completion_report_failed:{"status":"SUCCEEDED"}',
      { ...record, version: 2 },
      { ...record, payload: { status: 'WHAT' } },
      {
        ...record,
        payload: {
          status: 'REMOVED',
          audioHash: 'bad',
          errorCode: null,
          errorMessage: null,
        },
      },
    ]) {
      expect(ingestResultRecordSchema.safeParse(input).success).toBe(false);
    }
  });
});
