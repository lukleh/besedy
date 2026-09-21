import {
  hasCatalogAccess,
  hasCatalogPermission,
  type CatalogPolicyContext,
} from "@/lib/policy/catalog";

export function canViewEventArtworkCandidates(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) &&
    (hasCatalogPermission(context, "see_unreleased") ||
      hasCatalogPermission(context, "manage_event_artwork") ||
      hasCatalogPermission(context, "publish_event_artwork"))
  );
}

export function canManageEventArtworkCandidates(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "manage_event_artwork")
  );
}

export function canPublishEventArtwork(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "publish_event_artwork")
  );
}
