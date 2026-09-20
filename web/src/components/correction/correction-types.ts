import { z } from "zod";

export const spanStateSchema = z.enum([
  "needs_attention",
  "done",
  "needs_second_approval",
  "not_reviewed",
]);

export type SpanState = z.infer<typeof spanStateSchema>;

export const spanViewSchema = z.object({
  id: z.string(),
  ordinal: z.number(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  originalText: z.string(),
  text: z.string(),
  revisionId: z.string(),
  isEdited: z.boolean(),
  state: spanStateSchema,
  approverIds: z.array(z.string()),
  disapproverIds: z.array(z.string()),
  commentCount: z.number(),
  lastEditedById: z.string().nullable(),
  lastEditedAt: z.string().nullable(),
});

export type SpanView = z.infer<typeof spanViewSchema>;

export const spanPageSchema = z.object({
  workspaceId: z.string(),
  offset: z.number(),
  limit: z.number(),
  total: z.number(),
  spans: z.array(spanViewSchema),
});

export type SpanPage = z.infer<typeof spanPageSchema>;

export const workspaceSummarySchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  audioHash: z.string(),
  sourceBackend: z.string(),
  sourceFingerprint: z.string(),
  spanCount: z.number(),
  spanDurationSeconds: z.number(),
  status: z.enum(["ACTIVE", "ARCHIVED"]),
  readerPublicationId: z.string().nullable(),
  searchPublicationId: z.string().nullable(),
  lockedByPublicationId: z.string().nullable(),
  startedById: z.string().nullable(),
  createdAt: z.string(),
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const publicationEligibilitySchema = z.object({
  eligible: z.boolean(),
  spanCount: z.number(),
  doneSpanCount: z.number(),
  blockedSpanCount: z.number(),
  unreviewedSpanCount: z.number(),
  awaitingSecondApprovalCount: z.number(),
});

export type PublicationEligibility = z.infer<typeof publicationEligibilitySchema>;

export const correctionStateSchema = z.object({
  catalogId: z.string(),
  audioHash: z.string(),
  eligible: z.boolean(),
  canPublish: z.boolean(),
  guide: z.object({
    revisionId: z.string().nullable(),
    body: z.string(),
    authorId: z.string().nullable(),
    updatedAt: z.string().nullable(),
    isDefault: z.boolean(),
  }),
  candidateBackend: z.string().nullable(),
  workspace: workspaceSummarySchema.nullable(),
  progress: z
    .object({
      spanCount: z.number(),
      totalDurationSeconds: z.number(),
      reviewedOnceDurationSeconds: z.number(),
      fullyApprovedDurationSeconds: z.number(),
      doneSpanCount: z.number(),
      blockedSpanCount: z.number(),
    })
    .nullable(),
  publication: publicationEligibilitySchema.nullable(),
  resume: z
    .object({ spanId: z.string(), ordinal: z.number() })
    .nullable(),
});

export type CorrectionState = z.infer<typeof correctionStateSchema>;

export const spanCommandResultSchema = z.object({
  spanId: z.string(),
  revisionId: z.string(),
  text: z.string(),
  state: spanStateSchema,
  approverIds: z.array(z.string()),
  disapproverIds: z.array(z.string()),
  replayed: z.boolean(),
});

export const spanHistorySchema = z.object({
  spanId: z.string(),
  history: z.array(
    z.object({
      kind: z.enum(["revision", "decision", "comment"]),
      at: z.string(),
      userId: z.string().nullable(),
      revisionId: z.string(),
      actorName: z.string().nullable(),
      text: z.string().optional(),
      decision: z.enum(["APPROVE", "DISAPPROVE", "WITHDRAW"]).optional(),
      body: z.string().optional(),
    })
  ),
});

export type SpanHistory = z.infer<typeof spanHistorySchema>;
