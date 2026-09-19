import { logAccessDenied } from "@/lib/audit/logger";
import { AuthError } from "@/lib/auth/permissions";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { isPublishedVisibleEvent } from "@/lib/catalog-events/visibility";
import prisma from "@/lib/db";
import { requiresReleasedEventVisibilityScope } from "@/lib/policy/event";
import {
  canManageEventPosterCandidates,
  canPublishEventPosters,
  canViewEventPosterCandidates,
} from "@/lib/policy/event-poster";

export type EventPosterAccessMode = "view_candidates" | "manage" | "publish";

export async function requireEventPosterAccess(
  catalogId: string,
  eventId: number,
  mode: EventPosterAccessMode
): Promise<{ userId: string }> {
  const access = await requireCatalogEventsAccess(catalogId, "view");
  const allowed =
    mode === "view_candidates"
      ? canViewEventPosterCandidates(access.policyContext)
      : mode === "manage"
        ? canManageEventPosterCandidates(access.policyContext)
        : canPublishEventPosters(access.policyContext);

  if (!allowed) {
    await logAccessDenied(access.userId, "event_poster", String(eventId), {
      catalogId,
      mode,
      reason: "Missing event poster authority",
    });
    throw new AuthError("Access denied to event poster candidates", 403);
  }

  if (
    requiresReleasedEventVisibilityScope(access.catalogGrant) &&
    !(await isPublishedVisibleEvent(prisma, catalogId, eventId))
  ) {
    await logAccessDenied(access.userId, "event_poster", String(eventId), {
      catalogId,
      mode,
      reason: "Event is outside the actor's visibility scope",
    });
    throw new AuthError("Event not found", 404);
  }
  return { userId: access.userId };
}
