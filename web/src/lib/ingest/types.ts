import { z } from "zod";
import { RecordingIntakeStatus as PrismaRecordingIntakeStatus } from "@/generated/prisma/enums";

export const recordingIntakeStatusSchema = z.nativeEnum(PrismaRecordingIntakeStatus);

export type RecordingIntakeStatus = z.infer<typeof recordingIntakeStatusSchema>;

/** Statuses the worker can still advance; only these are worth polling for. */
export const ACTIVE_INTAKE_STATUSES: readonly RecordingIntakeStatus[] = [
  "QUEUED",
  "RUNNING",
  "REMOVING",
];

export const recordingIntakeSchema = z.object({
  id: z.string().min(1),
  catalogId: z.string().min(1),
  catalogLabel: z.string().nullable(),
  originalFilename: z.string(),
  sizeBytes: z.number(),
  receivedBytes: z.number(),
  mimeType: z.string().nullable(),
  status: recordingIntakeStatusSchema,
  jobId: z.string().nullable(),
  audioHash: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  requestedBy: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  prefectStateName: z.string().nullable().optional(),
});

export type RecordingIntakeDto = z.infer<typeof recordingIntakeSchema>;

export const recordingIntakeListSchema = z.object({
  intakes: z.array(recordingIntakeSchema),
});

export const createUploadResponseSchema = z.object({
  intakeId: z.string().min(1),
  chunkSizeBytes: z.number().int().positive(),
});

export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>;

export const chunkUploadResponseSchema = z.object({
  intakeId: z.string().min(1),
  receivedBytes: z.number(),
  receivedChunks: z.number().int(),
});

export const finalizeUploadResponseSchema = z.object({
  intake: recordingIntakeSchema,
});

export function isActiveIntakeStatus(status: RecordingIntakeStatus): boolean {
  return ACTIVE_INTAKE_STATUSES.includes(status);
}

export const REMOVABLE_INTAKE_STATUSES: readonly RecordingIntakeStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
];

export function isRemovableIntakeStatus(status: RecordingIntakeStatus): boolean {
  return REMOVABLE_INTAKE_STATUSES.includes(status);
}
