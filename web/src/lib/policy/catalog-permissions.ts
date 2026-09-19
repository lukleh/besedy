import type { AccessLevel, CatalogRole } from "@/generated/prisma/client";

/**
 * What an actor may do in one catalog.
 *
 * Every catalog gate asks whether a permission is present. The access level is
 * still where permissions come from — see `PERMISSIONS_BY_LEVEL` — but nothing
 * outside this module compares levels, so replacing the level scale with stored
 * roles later changes only the derivation.
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
  | "download"
  | "edit_metadata"
  | "manage_lookups"
  | "batch_edit_metadata"
  | "publish_recording"
  | "manage_events"
  | "release_events"
  | "manage_event_posters"
  | "manage_event_sources"
  | "use_deep_search"
  | "manage_access"
  | "manage_catalog_config"
  // Asked about by no gate yet; see the note above.
  | "correct_transcripts"
  | "publish_transcript"
  | "see_transcript_variants"
  | "see_speakers"
  // The single `download` splits into one permission per medium later. This
  // one is named early because the host role carries it as an extra, and an
  // extra that named nothing would be a typo nobody could catch.
  | "download_transcripts";

/** What each level adds to everything the levels below it already carry. */
const PERMISSIONS_BY_LEVEL: Record<AccessLevel, CatalogPermission[]> = {
  LISTENER: ["stream_audio", "browse_recordings"],
  VIEWER: ["see_unreleased", "read_transcripts", "search_transcripts"],
  MEMBER: ["download"],
  EDITOR: ["edit_metadata", "manage_lookups"],
  OWNER: [
    "batch_edit_metadata",
    "publish_recording",
    "manage_events",
    "release_events",
    "manage_event_posters",
    "manage_event_sources",
    "use_deep_search",
    "manage_access",
  ],
};

const LEVEL_ORDER: AccessLevel[] = ["LISTENER", "VIEWER", "MEMBER", "EDITOR", "OWNER"];

const CUMULATIVE_BY_LEVEL = new Map<AccessLevel, ReadonlySet<CatalogPermission>>(
  LEVEL_ORDER.map((level, index) => [
    level,
    new Set(LEVEL_ORDER.slice(0, index + 1).flatMap((l) => PERMISSIONS_BY_LEVEL[l])),
  ])
);

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
  download: true,
  edit_metadata: true,
  manage_lookups: true,
  batch_edit_metadata: true,
  publish_recording: true,
  manage_events: true,
  release_events: true,
  manage_event_posters: true,
  manage_event_sources: true,
  use_deep_search: true,
  manage_access: true,
  manage_catalog_config: true,
  correct_transcripts: true,
  publish_transcript: true,
  see_transcript_variants: true,
  see_speakers: true,
  download_transcripts: true,
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
  return PROTECTED_PERMISSIONS.some((permission) => permissions.has(permission));
}

const READER: CatalogPermission[] = [
  "stream_audio",
  "read_transcripts",
  "search_transcripts",
];

/**
 * What each role carries, per docs/adr/0005-catalog-permission-model.md.
 *
 * Nobody holds a role yet: every grant still resolves through its access level.
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
    "manage_event_sources",
    "use_deep_search",
    "download",
  ],
};

const PERMISSIONS_BY_ROLE = new Map<CatalogRole, ReadonlySet<CatalogPermission>>(
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
 * Everything a level carries, including what the levels below it carry.
 *
 * `manage_catalog_config` appears in no level on purpose: it belongs to catalog
 * administrators alone, and they hold every permission by being administrators.
 */
export function permissionsForLevel(
  catalogGrant: AccessLevel | null | undefined
): ReadonlySet<CatalogPermission> {
  if (catalogGrant == null) return NO_PERMISSIONS;
  return CUMULATIVE_BY_LEVEL.get(catalogGrant) ?? NO_PERMISSIONS;
}

/**
 * What one grant carries.
 *
 * `role` is authoritative once set. `level` is the legacy scale, kept as the
 * answer for grants the assignment has not reached yet; when every grant
 * carries a role it stops being read at all.
 */
export interface CatalogGrant {
  level: AccessLevel | null;
  role: CatalogRole | null;
  extras: string[];
}

/**
 * The role a legacy access level becomes, and what it carries on top.
 *
 * This mirrors the mapping in
 * `prisma/migrations/20260916170000_assign_catalog_roles`, and the two must
 * stay the same: that one moved the grants that existed, this one decides what
 * a grant written today becomes. The interface still names levels, so every
 * write path passes through here; the step that replaces the level picker with
 * a role picker is what retires it.
 */
export function roleForLevel(level: AccessLevel): {
  role: CatalogRole;
  extras: CatalogPermission[];
} {
  switch (level) {
    case "LISTENER":
      return { role: "listener", extras: [] };
    case "VIEWER":
    case "MEMBER":
      return { role: "reader", extras: [] };
    case "EDITOR":
      return { role: "curator", extras: [] };
    case "OWNER":
      return { role: "host", extras: ["download_transcripts"] };
  }
}

/**
 * The role fields to store beside a level, ready to spread into a write.
 */
export function roleFieldsForLevel(level: AccessLevel): {
  role: CatalogRole;
  extraPermissions: string[];
} {
  const { role, extras } = roleForLevel(level);
  return { role, extraPermissions: extras };
}

/**
 * A grant that carries nothing but a role.
 *
 * Used for the fixed visibility floors -- what MCP shows every reader, and what
 * an anonymous event listing shows -- which are a statement about how much of
 * the archive is on show rather than about anyone's grant.
 */
export function grantForRole(role: CatalogRole): CatalogGrant {
  return { level: null, role, extras: [] };
}

/**
 * A grant that carries nothing but a legacy level.
 *
 * Kept for the interface, which still names levels, and for tests that describe
 * a grant that way. Nothing stored resolves through it any more.
 */
export function grantFromLevel(level: AccessLevel | null): CatalogGrant {
  return { level, role: null, extras: [] };
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

  const base = grant.role != null
    ? permissionsForRole(grant.role)
    : permissionsForLevel(grant.level);

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
