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

export const publicationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const inFlightPublicationSchema = z.object({
  id: z.string(),
  status: z.enum(["PENDING", "ACTIVATING", "ROLLING_BACK"]),
  attemptCount: z.number(),
  indexJobId: z.string().nullable(),
  createdAt: z.string(),
  error: publicationErrorSchema.nullable(),
});

export type InFlightPublication = z.infer<typeof inFlightPublicationSchema>;

export const publishResultSchema = z.object({
  publicationId: z.string(),
  status: z.enum(["SUCCEEDED", "ACTIVATING", "FAILED"]),
  reused: z.boolean(),
  resumed: z.boolean(),
  error: publicationErrorSchema.nullable(),
});

export type PublishResult = z.infer<typeof publishResultSchema>;

export const correctionStateSchema = z.object({
  catalogId: z.string(),
  audioHash: z.string(),
  /** The recording is primary now, so a workspace may be started */
  canStart: z.boolean(),
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
  /** The publication currently holding the workspace, with its last error */
  activePublication: inFlightPublicationSchema.nullable(),
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

export const spanFilterSchema = z.enum([
  "all",
  "mine_open",
  "needs_attention",
  "needs_second_approval",
  "not_reviewed",
]);

export type SpanFilter = z.infer<typeof spanFilterSchema>;

export const stripSpanSchema = z.object({
  spanId: z.string(),
  ordinal: z.number(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  state: spanStateSchema,
  approvedByMe: z.boolean(),
  disapprovedByMe: z.boolean(),
});

export type StripSpan = z.infer<typeof stripSpanSchema>;

export const spanStripSchema = z.object({
  workspaceId: z.string(),
  spans: z.array(stripSpanSchema),
});

export const nextSpanSchema = z.object({
  next: z.object({ spanId: z.string(), ordinal: z.number() }).nullable(),
});

export const overviewStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "ready",
  "publishing",
  "published",
  "published_changed",
]);

export type OverviewStatus = z.infer<typeof overviewStatusSchema>;

const stateCountsSchema = z.object({
  needs_attention: z.number(),
  done: z.number(),
  needs_second_approval: z.number(),
  not_reviewed: z.number(),
});

export const overviewItemSchema = z.object({
  status: overviewStatusSchema,
  recording: z.object({
    audioHash: z.string(),
    title: z.string().nullable(),
    eventId: z.number().nullable(),
    eventTitle: z.string().nullable(),
    locationName: z.string().nullable(),
    dateYear: z.number().nullable(),
    dateMonth: z.number().nullable(),
    dateDay: z.number().nullable(),
    durationSeconds: z.number(),
  }),
  workspaceId: z.string().nullable(),
  progress: z
    .object({
      spanCount: z.number(),
      totalSeconds: z.number(),
      counts: stateCountsSchema,
      seconds: stateCountsSchema,
    })
    .nullable(),
  mine: z
    .object({
      approved: z.number(),
      disapproved: z.number(),
      waitingOnOthers: z.number(),
      open: z.number(),
    })
    .nullable(),
  touchedByMe: z.boolean(),
  lastActivity: z.object({ at: z.string(), actorName: z.string().nullable() }).nullable(),
  myLastActivityAt: z.string().nullable(),
  eligible: z.boolean(),
  changedSinceReaderPublication: z.number(),
  publication: z
    .object({
      inFlight: z
        .object({
          status: z.enum(["PENDING", "ACTIVATING", "ROLLING_BACK", "SUCCEEDED", "FAILED", "ROLLED_BACK"]),
          error: publicationErrorSchema.nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

export type OverviewItem = z.infer<typeof overviewItemSchema>;

export const correctionOverviewSchema = z.object({
  catalogId: z.string(),
  canPublish: z.boolean(),
  summary: z.object({
    byStatus: z.record(overviewStatusSchema, z.object({ count: z.number(), seconds: z.number() })),
  }),
  workspaces: z.array(overviewItemSchema),
  notStarted: z.object({ total: z.number(), items: z.array(overviewItemSchema) }),
});

export type CorrectionOverview = z.infer<typeof correctionOverviewSchema>;
