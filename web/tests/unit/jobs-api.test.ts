import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { correctionIndexJobSchema, ingestJobSchema } from '@/lib/jobs-api/schemas';
import { fetchJobsApi } from '@/lib/jobs-api/server';

describe('retained jobs API contracts', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('JOBS_API_BASE_URL', 'https://jobs.example.test/api');
    vi.stubEnv('BESEDY_JOB_SERVICE_SECRET', 'job-service-secret');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits authenticated ingest jobs and retains progress fields', async () => {
    const payload = { intakeId: 'intake-1', originalFilename: 'recording.wav' };
    const job = {
      id: 'ingest-1',
      kind: 'INGEST',
      status: 'RUNNING',
      requested_by_id: 'admin-1',
      catalog_id: 'catalog-1',
      payload,
      progress_label: 'Transcribing',
      prefectFlowRunId: 'flow-1',
    };
    fetchMock.mockResolvedValue(Response.json(job));

    await expect(
      fetchJobsApi('/jobs', { method: 'POST', body: payload, schema: ingestJobSchema }),
    ).resolves.toEqual(job);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url.href).toBe('https://jobs.example.test/api/jobs');
    expect(options.method).toBe('POST');
    expect(options.headers.get('Authorization')).toBe('Bearer job-service-secret');
    expect(options.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual(payload);
    expect(options.cache).toBe('no-store');
  });

  it('reads authenticated correction index jobs with operation identity intact', async () => {
    const job = {
      id: 'correction-1',
      kind: 'CORRECTION_INDEX',
      status: 'SUCCEEDED',
      catalog_id: 'catalog-1',
      payload: {
        audioHash: 'a'.repeat(64),
        operation: 'publish',
        operationToken: 'publication-1',
      },
      prefectFlowRunId: 'flow-2',
    };
    fetchMock.mockResolvedValue(Response.json(job));

    await expect(
      fetchJobsApi('/jobs/correction-1', { schema: correctionIndexJobSchema }),
    ).resolves.toEqual(job);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url.href).toBe('https://jobs.example.test/api/jobs/correction-1');
    expect(options.method).toBe('GET');
    expect(options.headers.get('Authorization')).toBe('Bearer job-service-secret');
  });
});
