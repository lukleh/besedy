import { z } from 'zod';

export const jobStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const ingestJobPayloadSchema = z
  .object({
    intakeId: z.string().nullable().optional(),
    originalFilename: z.string().nullable().optional(),
  })
  .passthrough();

export const ingestJobSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('INGEST'),
    status: jobStatusSchema,
    requested_by_id: z.string().nullable(),
    catalog_id: z.string().nullable(),
    payload: ingestJobPayloadSchema,
    error_message: z.string().nullable().optional(),
    progress_label: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    finished_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    prefectStateName: z.string().nullable().optional(),
    prefectStateType: z.string().nullable().optional(),
    prefectFlowRunId: z.string().nullable().optional(),
  })
  .passthrough();

export const correctionIndexJobSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('CORRECTION_INDEX'),
    status: jobStatusSchema,
    catalog_id: z.string().nullable(),
    payload: z
      .object({
        audioHash: z.string().nullable().optional(),
        operation: z.string().nullable().optional(),
        operationToken: z.string().nullable().optional(),
      })
      .passthrough(),
    error_message: z.string().nullable().optional(),
    prefectFlowRunId: z.string().nullable().optional(),
  })
  .passthrough();

export type IngestJob = z.infer<typeof ingestJobSchema>;
export type CorrectionIndexJob = z.infer<typeof correctionIndexJobSchema>;
