import type { CatalogRole } from "@/generated/prisma/client";
import {
  CATALOG_ROLES,
  carriesProtectedPermission,
  grantHasPermission,
  permissionsForGrant,
  type CatalogGrant,
  type GrantableExtraPermission,
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

/**
 * Whether the actor may browse the recordings list.
 *
 * A choice rather than a side effect. It used to be "anyone who can open the
 * catalog", which was then narrowed by accident: the tab switcher demanded
 * event-edit rights, so everybody below an owner was locked to events with no
 * path here at all. The permission says who the surface is for, and the
 * switcher asks about browsing rather than about editing.
 */
export function canBrowseRecordings(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "browse_recordings")
  );
}

export function canViewCatalogTranscripts(
  context: CatalogPolicyContext
): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "read_transcripts")
  );
}

/**
 * File delivery, one permission per thing delivered.
 *
 * There is no general "may download". Taking a file out of Besedy serves a
 * specific purpose, and which purpose decides which permission -- so an account
 * given transcripts does not thereby get audio, and neither of them gets the
 * whole corpus in one request.
 *
 * Each of these is never broader than reading: they decide whether an account
 * may take out what it can already open, not what it may open.
 */
export function canDownloadAudio(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) && hasCatalogPermission(context, "download_audio")
  );
}

/** The master, which no role carries; a catalog administrator holds it. */
export function canDownloadOriginalAudio(
  context: CatalogPolicyContext
): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "download_original_audio")
  );
}

export function canDownloadTranscripts(context: CatalogPolicyContext): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "download_transcripts")
  );
}

/**
 * The machine text under a corrected transcript. No role carries it, and
 * nothing serves it yet: there are no corrections, so there is no text
 * underneath one. Named and gated now so the correction work has a permission
 * to hang the variant on rather than inventing one then.
 */
export function canDownloadOriginalTranscript(
  context: CatalogPolicyContext
): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "download_original_transcript")
  );
}

/** The whole corpus as data: the highest-impact permission in the catalogue. */
export function canBulkExportTranscripts(
  context: CatalogPolicyContext
): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "bulk_export_transcripts")
  );
}

export function canEditCatalogMetadata(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) && hasCatalogPermission(context, "edit_metadata")
  );
}

/**
 * The recorder, location and album rows of this catalog.
 *
 * A different thing from `edit_metadata`, which is the curated metadata of one
 * recording: a lookup row is shared by every recording and event that names
 * it, so ADR 0007 gives it a permission of its own. The two sit on the same
 * role today, so this changes nothing for any current grant; it makes the
 * permission mean what it says.
 */
export function canManageCatalogLookups(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) && hasCatalogPermission(context, "manage_lookups")
  );
}

export function hasCatalogManagementAuthority(
  context: CatalogPolicyContext
): boolean {
  return (
    hasCatalogAccess(context) && hasCatalogPermission(context, "manage_access")
  );
}

export function canAccessCatalogSettings(
  context: CatalogPolicyContext
): boolean {
  return hasCatalogManagementAuthority(context);
}

export function canManageCatalogConfiguration(
  context: CatalogPolicyContext
): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "manage_catalog_config")
  );
}

export function canAttemptCatalogManagement(
  context: CatalogPolicyContext
): boolean {
  return (
    context.canEnterPortal && hasCatalogPermission(context, "manage_access")
  );
}

/** Whether the actor may assign this complete role-native grant. */
export function canGrantCatalogGrant(
  context: CatalogPolicyContext,
  role: CatalogRole,
  extras: readonly GrantableExtraPermission[] = []
): boolean {
  return mayPassOnGrant(context, { role, extras: [...extras] });
}

/** Whether the actor may update or restore an existing grant. */
export function canManageExistingCatalogGrant(
  context: CatalogPolicyContext,
  grant: CatalogGrant
): boolean {
  return mayPassOnGrant(context, grant);
}

/**
 * Whether the actor may revoke an existing grant.
 *
 * Revocation only removes access, so unknown or administrator-assigned extras
 * do not make an otherwise manageable role impossible for a host to cut off.
 * Protected roles remain administrator-only.
 */
export function canRevokeExistingCatalogGrant(
  context: CatalogPolicyContext,
  grant: CatalogGrant
): boolean {
  return mayPassOnGrant(context, { ...grant, extras: [] });
}

/** Roles the access UI may offer to this actor. */
export function manageableCatalogRoles(
  context: CatalogPolicyContext
): CatalogRole[] {
  return CATALOG_ROLES.filter((role) => canGrantCatalogGrant(context, role));
}

/** Extras are exceptions and only catalog administrators may assign them. */
export function canManageCatalogGrantExtras(
  context: CatalogPolicyContext
): boolean {
  return canAttemptCatalogManagement(context) && context.isCatalogAdmin;
}

function mayPassOnGrant(
  context: CatalogPolicyContext,
  grant: CatalogGrant
): boolean {
  if (!canAttemptCatalogManagement(context)) return false;
  if (context.isCatalogAdmin) return true;
  if ((grant.extras?.length ?? 0) > 0) return false;
  return !carriesProtectedPermission(permissionsForGrant(grant));
}

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

export function canBatchEditCatalogMetadata(
  context: CatalogPolicyContext
): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "batch_edit_metadata")
  );
}

/**
 * Semantic transcript search in the web application.
 *
 * Search returns transcript-derived content, so it must never be broader than
 * direct transcript access: `read_transcripts` is required, and
 * `search_transcripts` is required on top of it rather than instead of it.
 * Every role that reads also searches today, so the second permission changes
 * nothing for current grants; it exists so that a role that reads without
 * searching can be defined later.
 *
 * MCP does not consult this gate. Its reads resolve against a fixed listener
 * grant and no per-catalog permission (see docs/web/mcp-server.md).
 */
export function canUseCatalogRag(context: CatalogPolicyContext): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "search_transcripts")
  );
}
