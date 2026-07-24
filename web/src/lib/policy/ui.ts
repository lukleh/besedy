import type { AccessLevel } from "@/generated/prisma/client";
import { accessLevelAtLeast } from "@/lib/policy/access-level";

export interface CatalogTabPolicyContext {
  canBrowseRecordings: boolean;
  canBrowseEvents: boolean;
  canEditEvents: boolean;
}

export interface EventColumnPolicyContext {
  catalogGrant: AccessLevel | null;
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
  return (
    context.isCatalogAdmin ||
    (context.catalogGrant !== null &&
      accessLevelAtLeast(context.catalogGrant, "VIEWER"))
  );
}

export function canSeeAllEventColumns(context: EventColumnPolicyContext): boolean {
  return (
    context.isCatalogAdmin ||
    (context.catalogGrant !== null &&
      accessLevelAtLeast(context.catalogGrant, "OWNER"))
  );
}
