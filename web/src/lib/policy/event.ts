import type { AccessLevel } from "@/generated/prisma/client";
import { accessLevelAtLeast } from "@/lib/policy/access-level";
import { hasCatalogAccess, type CatalogPolicyContext } from "@/lib/policy/catalog";

export const EVENTS_VIEW_ACCESS_LEVEL: AccessLevel = "LISTENER";

export interface EventFeaturePolicyContext extends CatalogPolicyContext {
  featureEnabled: boolean;
}

export interface ListenerVisibleEventState {
  released: boolean;
  primaryRecordingActionable: boolean;
  primaryRecordingPublished: boolean;
}

export function requiresListenerEventVisibilityScope(
  catalogGrant: AccessLevel | null | undefined
): boolean {
  return catalogGrant === "LISTENER";
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
  state?: ListenerVisibleEventState
): boolean {
  if (!canBrowseEvents(context)) {
    return false;
  }

  if (!requiresListenerEventVisibilityScope(context.catalogGrant)) {
    return true;
  }

  return state !== undefined && isListenerVisibleEventState(state);
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

export function isListenerVisibleEventState(
  state: ListenerVisibleEventState
): boolean {
  return (
    state.released &&
    state.primaryRecordingActionable &&
    state.primaryRecordingPublished
  );
}
