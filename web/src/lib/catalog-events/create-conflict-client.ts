"use client";

import { ApiError } from "@/lib/api/fetch-json";
import {
  EventCreationConflictDetailsSchema,
  type EventCreationConflictDetails,
} from "@/lib/catalog-events/create-conflict";

export function readEventCreationConflict(
  error: unknown
): EventCreationConflictDetails | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;

  const details = (error.payload as { details?: unknown } | null)?.details;
  const parsed = EventCreationConflictDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : null;
}
