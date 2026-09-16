import type { AccessLevel } from "@/generated/prisma/client";
import {
  grantHasPermission,
  type CatalogPermission,
} from "@/lib/policy/catalog-permissions";

export interface CatalogPolicyContext {
  catalogExists: boolean;
  canEnterPortal: boolean;
  catalogGrant: AccessLevel | null;
  isCatalogAdmin: boolean;
}

/**
 * Whether the actor holds a permission in this catalog.
 *
 * Access to the catalog is checked separately by each caller, because a gate
 * that asks about a permission without first asking whether the actor may be
 * here at all would answer for someone who cannot open the catalog.
 */
export function hasCatalogPermission(
  context: CatalogPolicyContext,
  permission: CatalogPermission
): boolean {
  return grantHasPermission(
    context.catalogGrant,
    context.isCatalogAdmin,
    permission
  );
}

export function hasCatalogAccess(context: CatalogPolicyContext): boolean {
  return (
    context.catalogExists &&
    context.canEnterPortal &&
    (context.isCatalogAdmin || context.catalogGrant !== null)
  );
}

export function canViewCatalog(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context);
}

export function canBrowseRecordings(context: CatalogPolicyContext): boolean {
  return canViewCatalog(context);
}

export function canViewCatalogTranscripts(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context) && hasCatalogPermission(context, "read_transcripts");
}

export function canDownloadCatalogContent(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context) && hasCatalogPermission(context, "download");
}

export function canEditCatalogMetadata(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context) && hasCatalogPermission(context, "edit_metadata");
}

export function hasCatalogManagementAuthority(
  context: CatalogPolicyContext
): boolean {
  return hasCatalogAccess(context) && hasCatalogPermission(context, "manage_access");
}

export function canAccessCatalogSettings(
  context: CatalogPolicyContext
): boolean {
  return hasCatalogManagementAuthority(context);
}

export function canManageCatalogConfiguration(
  context: CatalogPolicyContext
): boolean {
  return hasCatalogAccess(context) && hasCatalogPermission(context, "manage_catalog_config");
}

export function canAttemptCatalogManagement(
  context: CatalogPolicyContext
): boolean {
  return context.canEnterPortal && hasCatalogPermission(context, "manage_access");
}

export function canGrantCatalogAccessLevel(
  context: CatalogPolicyContext,
  accessLevel: AccessLevel
): boolean {
  return canAttemptCatalogManagement(context) && (accessLevel !== "OWNER" || context.isCatalogAdmin);
}

export function canManageExistingCatalogAccessLevel(
  context: CatalogPolicyContext,
  accessLevel: AccessLevel
): boolean {
  return canAttemptCatalogManagement(context) && (accessLevel !== "OWNER" || context.isCatalogAdmin);
}

export function canBatchEditCatalogMetadata(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context) && hasCatalogPermission(context, "batch_edit_metadata");
}

export function canUseCatalogRag(context: CatalogPolicyContext): boolean {
  // Search returns transcript-derived content, so it must never be broader than
  // direct transcript access. Web and MCP both consume this capability.
  return canViewCatalogTranscripts(context);
}
