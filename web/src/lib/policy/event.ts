import type { AccessLevel } from "@/generated/prisma/client";
import { accessLevelAtLeast } from "@/lib/policy/access-level";
import { hasCatalogAccess, type CatalogPolicyContext } from "@/lib/policy/catalog";

export const EVENTS_VIEW_ACCESS_LEVEL: AccessLevel = "LISTENER";

export interface EventFeaturePolicyContext extends CatalogPolicyContext {
  featureEnabled: boolean;
}

export interface ReleasedVisibleEventState {
  released: boolean;
  primaryRecordingActionable: boolean;
  primaryRecordingPublished: boolean;
}

export function requiresReleasedEventVisibilityScope(
  catalogGrant: AccessLevel | null | undefined
): boolean {
  return catalogGrant === "LISTENER";
}

/**
 * Whether the actor may see events before release.
 *
 * Keep this as the canonical release-visibility decision for web and MCP. Query
 * builders use the inverse helper above to apply the listener-only DB scope.
 */
export function canViewUnreleasedEvents(
  context: CatalogPolicyContext
): boolean {
  return (
    hasCatalogAccess(context) &&
    !requiresReleasedEventVisibilityScope(context.catalogGrant)
  );
}

export function canBrowseEvents(context: EventFeaturePolicyContext): boolean {
  return (
    context.featureEnabled &&
    hasCatalogAccess(context) &&
    (context.isCatalogAdmin ||
      (context.catalogGrant !== null &&
        accessLevelAtLeast(context.catalogGrant, EVENTS_VIEW_ACCESS_LEVEL)))
  );
}

export function canViewCatalogEvents(context: EventFeaturePolicyContext): boolean {
  return canBrowseEvents(context);
}

export function canViewEvent(
  context: EventFeaturePolicyContext,
  state?: ReleasedVisibleEventState
): boolean {
  if (!canBrowseEvents(context)) {
    return false;
  }

  if (!requiresReleasedEventVisibilityScope(context.catalogGrant)) {
    return true;
  }

  return state !== undefined && isReleasedVisibleEventState(state);
}

export function canEditEvent(context: EventFeaturePolicyContext): boolean {
  return (
    canBrowseEvents(context) &&
    (context.isCatalogAdmin || context.catalogGrant === "OWNER")
  );
}

export function canEditCatalogEvents(context: EventFeaturePolicyContext): boolean {
  return canEditEvent(context);
}

export function canReleaseEvent(context: EventFeaturePolicyContext): boolean {
  return canEditEvent(context);
}

export function canAttachRecordingToEvent(context: EventFeaturePolicyContext): boolean {
  return canEditEvent(context);
}

export function canDetachRecordingFromEvent(context: EventFeaturePolicyContext): boolean {
  return canEditEvent(context);
}

export function canSetPrimaryRecording(context: EventFeaturePolicyContext): boolean {
  return canEditEvent(context);
}

export function canCreateEventFromRecording(context: EventFeaturePolicyContext): boolean {
  return canEditEvent(context);
}

export function isReleasedVisibleEventState(
  state: ReleasedVisibleEventState
): boolean {
  return (
    state.released &&
    state.primaryRecordingActionable &&
    state.primaryRecordingPublished
  );
}
