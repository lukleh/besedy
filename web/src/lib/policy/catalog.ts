import type { AccessLevel } from "@/generated/prisma/client";
import { accessLevelAtLeast } from "@/lib/policy/access-level";

export interface CatalogPolicyContext {
  catalogExists: boolean;
  canEnterPortal: boolean;
  catalogGrant: AccessLevel | null;
  isCatalogAdmin: boolean;
}

function hasCatalogGrantAtLeast(
  context: CatalogPolicyContext,
  requiredLevel: AccessLevel
): boolean {
  return (
    context.isCatalogAdmin ||
    (context.catalogGrant !== null &&
      accessLevelAtLeast(context.catalogGrant, requiredLevel))
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
  return hasCatalogAccess(context) && hasCatalogGrantAtLeast(context, "VIEWER");
}

export function canDownloadCatalogContent(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context) && hasCatalogGrantAtLeast(context, "MEMBER");
}

export function canEditCatalogMetadata(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context) && hasCatalogGrantAtLeast(context, "EDITOR");
}

export function hasCatalogManagementAuthority(
  context: CatalogPolicyContext
): boolean {
  return hasCatalogAccess(context) && (context.isCatalogAdmin || context.catalogGrant === "OWNER");
}

export function canAccessCatalogSettings(
  context: CatalogPolicyContext
): boolean {
  return hasCatalogManagementAuthority(context);
}

export function canManageCatalogConfiguration(
  context: CatalogPolicyContext
): boolean {
  return hasCatalogAccess(context) && context.isCatalogAdmin;
}

export function canAttemptCatalogManagement(
  context: CatalogPolicyContext
): boolean {
  return context.canEnterPortal && (context.isCatalogAdmin || context.catalogGrant === "OWNER");
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
  return hasCatalogManagementAuthority(context);
}

export function canUseCatalogRag(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context);
}
