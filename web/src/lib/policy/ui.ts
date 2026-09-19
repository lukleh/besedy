import {
  grantHasPermission,
  type CatalogGrant,
} from "@/lib/policy/catalog-permissions";

export interface CatalogTabPolicyContext {
  canBrowseRecordings: boolean;
  canBrowseEvents: boolean;
  canEditEvents: boolean;
}

export interface EventColumnPolicyContext {
  catalogGrant: CatalogGrant | null;
  isCatalogAdmin: boolean;
}

/**
 * Whether to offer a switch between the two surfaces.
 *
 * Both of them, and nothing else. Requiring event-edit rights here is what
 * made browsing recordings an accident: it hid the switch from everyone who
 * could not edit events, and with it the only path to the recordings list.
 */
export function canUseCatalogTabSwitcher(
  context: CatalogTabPolicyContext
): boolean {
  return context.canBrowseRecordings && context.canBrowseEvents;
}

export function canSeeRecordingsTab(context: CatalogTabPolicyContext): boolean {
  return canUseCatalogTabSwitcher(context);
}

export function canSeeEventsTab(context: CatalogTabPolicyContext): boolean {
  return canUseCatalogTabSwitcher(context);
}

export function canSeePublicationControls(
  canManagePublication: boolean
): boolean {
  return canManagePublication;
}

export function canSeeReleaseState(context: EventColumnPolicyContext): boolean {
  // Whoever may see unreleased events is who the indicator is for.
  return grantHasPermission(
    context.catalogGrant,
    context.isCatalogAdmin,
    "see_unreleased"
  );
}

export function canSeeAllEventColumns(context: EventColumnPolicyContext): boolean {
  // The administrative columns describe work only an event manager does.
  return grantHasPermission(
    context.catalogGrant,
    context.isCatalogAdmin,
    "manage_events"
  );
}
