import type { AccessLevel, CatalogRole } from "@/generated/prisma/client";

/**
 * What an actor may do in one catalog.
 *
 * Every catalog gate asks whether a permission is present. Stored roles and
 * additive extras are authoritative; the retired access-level scale plays no
 * part in it. `legacyLevelForRole`/`grantFieldsForRole` below are write-side
 * plumbing only, kept until a follow-up migration drops the legacy column.
 *
 * Some of these are not asked about anywhere yet. They exist because the roles
 * below are defined over the whole vocabulary rather than over the part that
 * happens to be wired, and a permission nothing checks simply grants nothing
 * until its step wires the check. The single `download` splits into one
 * permission per medium in the step that splits the check.
 */
export type CatalogPermission =
  | "stream_audio"
  | "browse_recordings"
  | "see_unreleased"
  | "read_transcripts"
  | "search_transcripts"
  | "download_audio"
  | "bulk_export_transcripts"
  | "edit_metadata"
  | "manage_lookups"
  | "batch_edit_metadata"
  | "publish_recording"
  | "manage_events"
  | "release_events"
  | "manage_event_posters"
  | "publish_event_posters"
  | "manage_event_sources"
  | "use_deep_search"
  | "manage_access"
  | "manage_catalog_config"
  // Asked about by no gate yet; see the note above.
  | "correct_transcripts"
  | "publish_transcript"
  | "see_transcript_variants"
  | "see_speakers"
  | "download_transcripts"
  // The master is not what anyone is offered, so it belongs to no role at all;
  // a catalog administrator holds it by holding everything.
  | "download_original_audio"
  // The machine text under a corrected transcript is an editorial artefact, so
  // it goes with the editorial role rather than with reading.
  | "download_original_transcript";

export const CATALOG_ROLES = [
  "listener",
  "reader",
  "corrector",
  "host",
  "curator",
  "catalog_admin",
] as const satisfies readonly CatalogRole[];

/**
 * Exceptions that are useful to assign to one account through the access UI.
 *
 * The permission vocabulary is wider than this list. Role-defining and future
 * permissions stay attached to roles until there is a product surface for
 * granting them deliberately.
 */
export const GRANTABLE_EXTRA_PERMISSIONS = [
  "browse_recordings",
  "use_deep_search",
  "download_audio",
  "download_original_audio",
  "download_transcripts",
  "bulk_export_transcripts",
  "manage_event_posters",
  "publish_event_posters",
] as const satisfies readonly CatalogPermission[];

export type GrantableExtraPermission =
  (typeof GRANTABLE_EXTRA_PERMISSIONS)[number];

const NO_PERMISSIONS: ReadonlySet<CatalogPermission> = new Set();

/**
 * Every permission there is.
 *
 * Written as a record keyed by the union so that adding a permission to the type
 * fails to compile until it is listed here, which is what keeps the catalog
 * administrator's wildcard honest without anyone having to remember it.
 */
const EVERY_PERMISSION: Record<CatalogPermission, true> = {
  stream_audio: true,
  browse_recordings: true,
  see_unreleased: true,
  read_transcripts: true,
  search_transcripts: true,
  download_audio: true,
  bulk_export_transcripts: true,
  edit_metadata: true,
  manage_lookups: true,
  batch_edit_metadata: true,
  publish_recording: true,
  manage_events: true,
  release_events: true,
  manage_event_posters: true,
  publish_event_posters: true,
  manage_event_sources: true,
  use_deep_search: true,
  manage_access: true,
  manage_catalog_config: true,
  correct_transcripts: true,
  publish_transcript: true,
  see_transcript_variants: true,
  see_speakers: true,
  download_transcripts: true,
  download_original_audio: true,
  download_original_transcript: true,
};

const ALL_PERMISSIONS: ReadonlySet<CatalogPermission> = new Set(
  Object.keys(EVERY_PERMISSION) as CatalogPermission[]
);

/**
 * Permissions that only a catalog administrator may pass on.
 *
 * `manage_access` is protected so that granting cannot propagate itself: the
 * account that can mint accounts which grant is the administrator, and nobody
 * below can widen that circle. `see_unreleased` is protected so that sight of
 * unreleased material stays an administrative decision — a curator sees it but
 * cannot hand it on.
 *
 * The test is on what a grant carries rather than on its name, so a role or a
 * level added later is classified without touching this list.
 */
const PROTECTED_PERMISSIONS: CatalogPermission[] = [
  "manage_access",
  "see_unreleased",
];

/** Whether a set of permissions contains anything only an administrator may give. */
export function carriesProtectedPermission(
  permissions: ReadonlySet<CatalogPermission>
): boolean {
  return PROTECTED_PERMISSIONS.some((permission) =>
    permissions.has(permission)
  );
}

const READER: CatalogPermission[] = [
  "stream_audio",
  "read_transcripts",
  "search_transcripts",
];

/**
 * What each role carries, per docs/adr/0005-catalog-permission-model.md.
 *
 * `catalog_admin` is deliberately absent — it is a wildcard rather than a list,
 * so a permission added later accrues to it without anyone remembering to.
 */
export const ROLE_PERMISSIONS: Record<
  Exclude<CatalogRole, "catalog_admin">,
  CatalogPermission[]
> = {
  listener: ["stream_audio"],
  reader: READER,
  corrector: [...READER, "correct_transcripts"],
  host: [...READER, "manage_access"],
  curator: [
    ...READER,
    "see_unreleased",
    "browse_recordings",
    "correct_transcripts",
    "publish_transcript",
    "edit_metadata",
    "batch_edit_metadata",
    "manage_lookups",
    "publish_recording",
    "manage_events",
    "release_events",
    "manage_event_posters",
    "publish_event_posters",
    "manage_event_sources",
    "use_deep_search",
    "download_audio",
    "download_transcripts",
    "download_original_transcript",
    "bulk_export_transcripts",
  ],
};

const PERMISSIONS_BY_ROLE = new Map<
  CatalogRole,
  ReadonlySet<CatalogPermission>
>(
  Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => [
    role as CatalogRole,
    new Set(permissions),
  ])
);

/** Everything a role carries. A catalog administrator holds all of them. */
export function permissionsForRole(
  role: CatalogRole | null | undefined
): ReadonlySet<CatalogPermission> {
  if (role == null) return NO_PERMISSIONS;
  if (role === "catalog_admin") return ALL_PERMISSIONS;
  return PERMISSIONS_BY_ROLE.get(role) ?? NO_PERMISSIONS;
}

/**
 * What one grant carries. `role` is authoritative; extras are additive.
 */
export interface CatalogGrant {
  role: CatalogRole | null;
  extras: string[];
}

/**
 * Compatibility value for `pending_catalog_grant.access_level`, which is
 * still `NOT NULL` with no default. Nothing reads this value for permissions
 * or display any more; it exists only to satisfy the column until a
 * follow-up migration drops it (see docs/adr/0005-catalog-permission-model.md).
 */
export function legacyLevelForRole(role: CatalogRole): AccessLevel {
  switch (role) {
    case "listener":
      return "LISTENER";
    case "reader":
    case "corrector":
      return "VIEWER";
    case "curator":
      return "EDITOR";
    case "host":
    case "catalog_admin":
      return "OWNER";
  }
}

/** Fields stored for a role-native grant while the legacy column still exists. */
export function grantFieldsForRole(
  role: CatalogRole,
  extras: readonly string[] = []
): {
  accessLevel: AccessLevel;
  role: CatalogRole;
  extraPermissions: string[];
} {
  return {
    accessLevel: legacyLevelForRole(role),
    role,
    extraPermissions: [...new Set(extras)],
  };
}

/**
 * Replace the extras this build knows how to grant without erasing permissions
 * written by a newer build or an external migration.
 */
export function mergeGrantableExtraPermissions(
  existing: readonly string[],
  requested: readonly GrantableExtraPermission[]
): string[] {
  const grantable = new Set<string>(GRANTABLE_EXTRA_PERMISSIONS);
  return [
    ...existing.filter((permission) => !grantable.has(permission)),
    ...requested,
  ];
}

/**
 * A grant that carries nothing but a role.
 *
 * Used for the fixed visibility floors -- what MCP shows every reader, and what
 * an anonymous event listing shows -- which are a statement about how much of
 * the archive is on show rather than about anyone's grant.
 */
export function grantForRole(role: CatalogRole): CatalogGrant {
  return { role, extras: [] };
}

/**
 * Everything a grant carries: its role's permissions plus its extras.
 *
 * Extras are additive only, so the role name stays a lower bound on what the
 * account may do. An extra naming a permission this build does not know is
 * ignored rather than rejected, which is what lets the set grow without a
 * migration.
 */
export function permissionsForGrant(
  grant: CatalogGrant | null | undefined
): ReadonlySet<CatalogPermission> {
  if (grant == null) return NO_PERMISSIONS;

  const base = permissionsForRole(grant.role);

  // A permission check must never throw: a grant that arrives without its
  // extras carries none, which fails closed.
  const extras = grant.extras ?? [];
  if (extras.length === 0) return base;

  const resolved = new Set(base);
  for (const extra of extras) {
    if (extra in EVERY_PERMISSION) {
      resolved.add(extra as CatalogPermission);
    }
  }
  return resolved;
}

/**
 * Whether a grant carries a permission, treating a catalog administrator as
 * holding all of them rather than as occupying the top of the scale.
 */
export function grantHasPermission(
  catalogGrant: CatalogGrant | null | undefined,
  isCatalogAdmin: boolean,
  permission: CatalogPermission
): boolean {
  if (isCatalogAdmin) return true;
  return permissionsForGrant(catalogGrant).has(permission);
}
