import type { AccessLevel } from "@/generated/prisma/client";
import {
  carriesProtectedPermission,
  grantHasPermission,
  permissionsForGrant,
  roleForLevel,
  type CatalogGrant,
  type CatalogPermission,
} from "@/lib/policy/catalog-permissions";

export interface CatalogPolicyContext {
  catalogExists: boolean;
  canEnterPortal: boolean;
  catalogGrant: CatalogGrant | null;
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

/**
 * Whether the actor may hand out this much access.
 *
 * A catalog administrator may give anything. Everyone else may give only what
 * carries no protected permission, which is what stops `manage_access` from
 * propagating itself and keeps unreleased material an administrative decision.
 */
export function canGrantCatalogAccessLevel(
  context: CatalogPolicyContext,
  accessLevel: AccessLevel
): boolean {
  return mayPassOnAccessLevel(context, accessLevel);
}

/**
 * Whether the actor may change or revoke access that is already held.
 *
 * The same test as granting, asked about the access being replaced. Without it
 * the rule would stop privilege spreading upward while still letting an account
 * strip one above it, which is the same authority wearing a different hat.
 */
export function canManageExistingCatalogAccessLevel(
  context: CatalogPolicyContext,
  accessLevel: AccessLevel
): boolean {
  return mayPassOnAccessLevel(context, accessLevel);
}

/**
 * The one test both sides of an access change ask, written once so that the
 * assigned side and the replaced side cannot drift apart.
 */
function mayPassOnAccessLevel(
  context: CatalogPolicyContext,
  accessLevel: AccessLevel
): boolean {
  if (!canAttemptCatalogManagement(context)) return false;
  if (context.isCatalogAdmin) return true;

  // The interface still names a level, but what a grant carries is the role it
  // becomes, so that is what the test asks about. It is also what lets a host
  // hand out reading again: VIEWER carried see_unreleased, `reader` does not.
  const { role, extras } = roleForLevel(accessLevel);
  return !carriesProtectedPermission(
    permissionsForGrant({ level: accessLevel, role, extras })
  );
}

/**
 * Every access level this actor may hand out or take away.
 *
 * The UI needs the set rather than the test so that it can offer exactly what
 * the server will accept: a level the actor cannot assign is not shown, and a
 * grant the actor cannot touch carries no edit or revoke action. One list
 * serves both sides because the granting rule asks the same question of the
 * access being assigned and the access being replaced.
 */
export function manageableCatalogAccessLevels(
  context: CatalogPolicyContext
): AccessLevel[] {
  return ACCESS_LEVELS.filter((level) => mayPassOnAccessLevel(context, level));
}

const ACCESS_LEVELS: AccessLevel[] = [
  "LISTENER",
  "VIEWER",
  "MEMBER",
  "EDITOR",
  "OWNER",
];

/**
 * Whether the actor is the subject of this change.
 *
 * Nobody changes their own access, administrators included: a holder of
 * `manage_access` cannot assign themselves a role, protected or not, and an
 * administrator's authority comes from their system role rather than from a
 * grant, so refusing them costs nothing and keeps one rule instead of two.
 * This generalizes the two narrow self-checks the routes carried before — one
 * stopping an owner demoting itself, one stopping any account revoking its own.
 *
 * A subject with no account — a grant pending a first sign-in — is nobody's
 * self: the actor is signed in, so they cannot be an account that does not
 * exist yet.
 */
export function isSelfCatalogAccessChange(
  actorUserId: string | null | undefined,
  subjectUserId: string | null | undefined
): boolean {
  if (!actorUserId || !subjectUserId) return false;
  return actorUserId === subjectUserId;
}

export function canBatchEditCatalogMetadata(context: CatalogPolicyContext): boolean {
  return hasCatalogAccess(context) && hasCatalogPermission(context, "batch_edit_metadata");
}

export function canUseCatalogRag(context: CatalogPolicyContext): boolean {
  // Search returns transcript-derived content, so it must never be broader than
  // direct transcript access. Web and MCP both consume this capability.
  return canViewCatalogTranscripts(context);
}
