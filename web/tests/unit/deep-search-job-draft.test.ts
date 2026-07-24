import { describe, expect, it } from 'vitest';
import { getDeepSearchJobDraft } from '@/components/deep-search/deep-search-job-draft';
import type { DeepSearchJob } from '@/lib/jobs-api/schemas';

function deepSearchJob(payload: DeepSearchJob['payload']): DeepSearchJob {
  return {
    id: 'job-1',
    kind: 'DEEP_SEARCH',
    status: 'SUCCEEDED',
    requested_by_id: 'user-1',
    catalog_id: 'catalog-1',
    payload,
    result: null,
    result_preview: null,
    error_code: null,
    error_message: null,
    progress_label: null,
    progress_pct: null,
    created_at: null,
    started_at: null,
    finished_at: null,
    updated_at: null,
    prefectStateName: 'Completed',
    prefectStateType: 'COMPLETED',
    prefectFlowRunId: 'job-1',
    prefectDeploymentId: null,
    prefectWorkPoolName: 'besedy-deep-search',
    artifacts: [],
    outputBundle: {},
  };
}

describe('getDeepSearchJobDraft', () => {
  it('copies submitted query and instructions into a new-job draft', () => {
    const draft = getDeepSearchJobDraft(
      deepSearchJob({
        query: 'What was said about Brno?',
        instructions: 'Return a table',
        retrieval: { top_k: 10 },
        execution: {},
      }),
    );

    expect(draft).toEqual({
      query: 'What was said about Brno?',
      instructions: 'Return a table',
    });
  });

  it('keeps missing instructions empty instead of patching old job data', () => {
    const draft = getDeepSearchJobDraft(
      deepSearchJob({
        query: 'What was said about Brno?',
        instructions: null,
        retrieval: {},
        execution: {},
      }),
    );

    expect(draft).toEqual({
      query: 'What was said about Brno?',
      instructions: '',
    });
  });
});
