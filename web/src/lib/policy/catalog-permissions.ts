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
  | "see_speakers";

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
};

const ALL_PERMISSIONS: ReadonlySet<CatalogPermission> = new Set(
  Object.keys(EVERY_PERMISSION) as CatalogPermission[]
);

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
 * Whether a grant carries a permission, treating a catalog administrator as
 * holding all of them rather than as occupying the top of the scale.
 */
export function grantHasPermission(
  catalogGrant: AccessLevel | null | undefined,
  isCatalogAdmin: boolean,
  permission: CatalogPermission
): boolean {
  if (isCatalogAdmin) return true;
  return permissionsForLevel(catalogGrant).has(permission);
}
