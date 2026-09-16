import type { AccessLevel } from "@/generated/prisma/client";

/**
 * What an actor may do in one catalog.
 *
 * Every catalog gate asks whether a permission is present. The access level is
 * still where permissions come from — see `PERMISSIONS_BY_LEVEL` — but nothing
 * outside this module compares levels, so replacing the level scale with stored
 * roles later changes only the derivation.
 *
 * The set covers the checks that exist today and no more. Permissions the
 * design calls for but nothing yet asks about — correcting transcripts, seeing
 * backend variants — arrive with the step that introduces their check, and the
 * single `download` here splits into one permission per medium in the step that
 * splits the check.
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
  | "manage_catalog_config";

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
