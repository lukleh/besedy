import { lacksUnreleasedVisibility } from "@/lib/policy/access-level";
import type { CatalogGrant } from "@/lib/policy/catalog-permissions";
import {
  hasCatalogAccess,
  hasCatalogPermission,
  type CatalogPolicyContext,
} from "@/lib/policy/catalog";

export interface EventFeaturePolicyContext extends CatalogPolicyContext {
  featureEnabled: boolean;
}

export interface ReleasedVisibleEventState {
  released: boolean;
  primaryRecordingActionable: boolean;
  primaryRecordingPublished: boolean;
}

export function requiresReleasedEventVisibilityScope(
  catalogGrant: CatalogGrant | null | undefined
): boolean {
  return lacksUnreleasedVisibility(catalogGrant);
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

/**
 * Whether the actor may browse events.
 *
 * Browsing events is not browsing recordings, and asking for
 * `browse_recordings` here made it look like it was. Under the level scale the
 * two were indistinguishable because every level carried that permission; under
 * the roles they are not, and a listener asked for a permission only the curator
 * holds would lose the events view, which is the surface the archive is used
 * through. Events are what an account with access to the catalog sees.
 */
export function canBrowseEvents(context: EventFeaturePolicyContext): boolean {
  return context.featureEnabled && hasCatalogAccess(context);
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
  return canBrowseEvents(context) && hasCatalogPermission(context, "manage_events");
}

export function canEditCatalogEvents(context: EventFeaturePolicyContext): boolean {
  return canEditEvent(context);
}

/**
 * Whether the actor may change an event's release state.
 *
 * `release_events` is its own permission in ADR 0005, separate from
 * `manage_events`: preparing an event and putting it in front of its audience
 * are different acts, even though today the same role does both. The gate used
 * to be `canEditEvent`, which asked `manage_events` and left the release
 * permission defined but never consulted. The PATCH route still requires
 * `manage_events` to reach the edit at all, so release is a second check on
 * top of edit rather than a way around it.
 */
export function canReleaseEvent(context: EventFeaturePolicyContext): boolean {
  return (
    canBrowseEvents(context) && hasCatalogPermission(context, "release_events")
  );
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

/**
 * Whether the actor may read and write an event's source records.
 *
 * Asked of the catalog context rather than the events feature context because
 * the capability projection answers it before any feature flag is known; the
 * source routes still pass the events "view" gate first. The permission is
 * `manage_event_sources`, which sits with the curator. Under the level scale the
 * routes fell through to `manage_access`, which handed sources to the host and
 * withheld them from the curator, the opposite of what ADR 0005 assigns.
 */
export function canManageEventSources(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "manage_event_sources")
  );
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
