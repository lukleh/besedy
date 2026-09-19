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

export function canUseCatalogTabSwitcher(
  context: CatalogTabPolicyContext
): boolean {
  return (
    context.canBrowseRecordings &&
    context.canBrowseEvents &&
    context.canEditEvents
  );
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
