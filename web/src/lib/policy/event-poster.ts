import {
  hasCatalogAccess,
  hasCatalogPermission,
  type CatalogPolicyContext,
} from "@/lib/policy/catalog";

export function canViewPublishedEventPoster(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context);
}

export function canViewEventPosterCandidates(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) &&
    (hasCatalogPermission(context, "see_unreleased") ||
      hasCatalogPermission(context, "manage_event_posters") ||
      hasCatalogPermission(context, "publish_event_posters"))
  );
}

export function canManageEventPosterCandidates(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "manage_event_posters")
  );
}

export function canPublishEventPosters(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "publish_event_posters")
  );
}
