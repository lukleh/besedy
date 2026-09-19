import { z } from "zod";

export const CREATE_DISTINCT_EVENT_INTENT = "create_distinct" as const;
export const EVENT_CREATION_REQUIRES_DECISION =
  "EVENT_CREATION_REQUIRES_DECISION" as const;

export const EventCreationCandidateSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().nullable(),
  sessionIndex: z.number().int().positive(),
  recordingCount: z.number().int().nonnegative(),
  primaryTitle: z.string().nullable(),
});

export const EventCreationConflictDetailsSchema = z.object({
  reason: z.literal(EVENT_CREATION_REQUIRES_DECISION),
  candidates: z.array(EventCreationCandidateSchema).min(1),
});

export type EventCreationCandidate = z.infer<
  typeof EventCreationCandidateSchema
>;
export type EventCreationConflictDetails = z.infer<
  typeof EventCreationConflictDetailsSchema
>;

export function buildEventCreationConflictDetails(
  candidates: EventCreationCandidate[]
): EventCreationConflictDetails {
  return {
    reason: EVENT_CREATION_REQUIRES_DECISION,
    candidates,
  };
}
