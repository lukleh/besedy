import { z } from 'zod';

const jsonObjectSchema = z.record(z.string(), z.unknown());
const deepSearchJobAccessSchema = z.enum(['owner', 'shared']);

export const deepSearchShareUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
});

export const deepSearchJobStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const deepSearchJobPayloadSchema = z
  .object({
    query: z.string().nullable().optional(),
    instructions: z.string().nullable().optional(),
    retrieval: jsonObjectSchema.nullish(),
    execution: jsonObjectSchema.nullish(),
  })
  .passthrough();

export const deepSearchJobArtifactSchema = z
  .object({
    name: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough();

export const deepSearchJobOutputBundleSchema = z
  .object({
    bundleDir: z.string().nullable().optional(),
    reportMarkdownPath: z.string().nullable().optional(),
    initialHitsPath: z.string().nullable().optional(),
    followupTracePath: z.string().nullable().optional(),
    runMetadataPath: z.string().nullable().optional(),
  })
  .passthrough();

export const deepSearchRlmProgressSchema = z
  .object({
    steps: z.number().nullable().optional(),
    toolCalls: z.number().nullable().optional(),
    subLlmCalls: z.number().nullable().optional(),
    searchCalls: z.number().nullable().optional(),
    windowCalls: z.number().nullable().optional(),
    uniqueChunks: z.number().nullable().optional(),
    uniqueAudioHashes: z.number().nullable().optional(),
    retrievedTextChars: z.number().nullable().optional(),
    retrievedContextChars: z.number().nullable().optional(),
  })
  .passthrough();

export const deepSearchJobSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('DEEP_SEARCH'),
    status: deepSearchJobStatusSchema,
    requested_by_id: z.string().nullable(),
    catalog_id: z.string().nullable(),
    payload: deepSearchJobPayloadSchema,
    result: jsonObjectSchema.nullable().optional(),
    result_preview: z.string().nullable().optional(),
    error_code: z.string().nullable().optional(),
    error_message: z.string().nullable().optional(),
    progress_label: z.string().nullable().optional(),
    progress_pct: z.number().nullable().optional(),
    created_at: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    finished_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    access: deepSearchJobAccessSchema.optional(),
    sharedBy: deepSearchShareUserSchema.nullable().optional(),
    sharedAt: z.string().nullable().optional(),
    prefectStateName: z.string().nullable().optional(),
    prefectStateType: z.string().nullable().optional(),
    prefectFlowRunId: z.string().nullable().optional(),
    prefectDeploymentId: z.string().nullable().optional(),
    prefectWorkPoolName: z.string().nullable().optional(),
    rlmProgress: deepSearchRlmProgressSchema.nullable().optional(),
    artifacts: z.array(deepSearchJobArtifactSchema).optional().default([]),
    outputBundle: deepSearchJobOutputBundleSchema.optional(),
  })
  .passthrough();

export const deepSearchJobsListSchema = z.object({
  jobs: z.array(deepSearchJobSchema),
});

export const deepSearchJobShareSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  catalogId: z.string().min(1),
  ownerUserId: z.string().min(1),
  sharedWithUserId: z.string().min(1),
  createdAt: z.string().nullable().optional(),
  user: deepSearchShareUserSchema,
});

export const deepSearchJobSharesSchema = z.object({
  shares: z.array(deepSearchJobShareSchema),
});

export const deepSearchShareUserSearchResultSchema = deepSearchShareUserSchema.extend({
  type: z.literal('available'),
});

export const deepSearchShareUserSearchSchema = z.object({
  users: z.array(deepSearchShareUserSearchResultSchema),
});

export const deepSearchCreateShareInputSchema = z.object({
  userId: z.string().min(1),
});

export const deepSearchJobHistoryEventSchema = z
  .object({
    event_type: z.string().optional(),
    stateName: z.string().nullable().optional(),
    stateType: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })
  .passthrough();

export const deepSearchJobHistorySchema = z
  .object({
    events: z.array(deepSearchJobHistoryEventSchema).optional().default([]),
    artifacts: z.array(deepSearchJobArtifactSchema).optional().default([]),
    prefectUiUrl: z.string().nullable().optional(),
  })
  .passthrough();

export const deepSearchSubmitInputSchema = z
  .object({
    query: z.string().trim().min(1).max(4000),
    instructions: z.string().trim().min(1).max(4000).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if ('form' in value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'form has been removed. Use instructions.',
        path: ['form'],
      });
    }
  });

export type DeepSearchJobStatus = z.infer<typeof deepSearchJobStatusSchema>;
export type DeepSearchJob = z.infer<typeof deepSearchJobSchema>;
export type DeepSearchJobsList = z.infer<typeof deepSearchJobsListSchema>;
export type DeepSearchJobAccess = z.infer<typeof deepSearchJobAccessSchema>;
export type DeepSearchShareUser = z.infer<typeof deepSearchShareUserSchema>;
export type DeepSearchJobShare = z.infer<typeof deepSearchJobShareSchema>;
export type DeepSearchJobShares = z.infer<typeof deepSearchJobSharesSchema>;
export type DeepSearchShareUserSearch = z.infer<typeof deepSearchShareUserSearchSchema>;
export type DeepSearchJobHistory = z.infer<typeof deepSearchJobHistorySchema>;
export type DeepSearchSubmitInput = z.infer<typeof deepSearchSubmitInputSchema>;
