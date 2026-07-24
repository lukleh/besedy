import type { DeepSearchJob } from '@/lib/jobs-api/schemas';

export interface DeepSearchJobDraft {
  query: string;
  instructions: string;
}

export function getDeepSearchJobDraft(job: DeepSearchJob): DeepSearchJobDraft {
  const query = typeof job.payload.query === 'string' ? job.payload.query : '';
  const instructions =
    typeof job.payload.instructions === 'string' && job.payload.instructions.trim()
      ? job.payload.instructions
      : '';

  return { query, instructions };
}
