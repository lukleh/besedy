import { logAccessDenied } from "@/lib/audit/logger";
import { AuthError } from "@/lib/auth/permissions";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { isPublishedVisibleEvent } from "@/lib/catalog-events/visibility";
import prisma from "@/lib/db";
import { requiresReleasedEventVisibilityScope } from "@/lib/policy/event";
import {
  canManageEventArtworkCandidates,
  canPublishEventArtwork,
  canViewEventArtworkCandidates,
} from "@/lib/policy/event-artwork";

export type EventArtworkAccessMode = "view_candidates" | "manage" | "publish";

export async function requireEventArtworkAccess(
  catalogId: string,
  eventId: number,
  mode: EventArtworkAccessMode
): Promise<{ userId: string }> {
  const access = await requireCatalogEventsAccess(catalogId, "view");
  const allowed =
    mode === "view_candidates"
      ? canViewEventArtworkCandidates(access.policyContext)
      : mode === "manage"
        ? canManageEventArtworkCandidates(access.policyContext)
        : canPublishEventArtwork(access.policyContext);

  if (!allowed) {
    await logAccessDenied(access.userId, "event_artwork", String(eventId), {
      catalogId,
      mode,
      reason: "Missing event artwork authority",
    });
    throw new AuthError("Access denied to event artwork candidates", 403);
  }

  if (
    requiresReleasedEventVisibilityScope(access.catalogGrant) &&
    !(await isPublishedVisibleEvent(prisma, catalogId, eventId))
  ) {
    await logAccessDenied(access.userId, "event_artwork", String(eventId), {
      catalogId,
      mode,
      reason: "Event is outside the actor's visibility scope",
    });
    throw new AuthError("Event not found", 404);
  }
  return { userId: access.userId };
}
