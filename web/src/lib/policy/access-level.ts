import type { AccessLevel } from "@/generated/prisma/client";

const ACCESS_LEVEL_ORDER: AccessLevel[] = [
  "LISTENER",
  "VIEWER",
  "MEMBER",
  "EDITOR",
  "OWNER",
];

export function accessLevelAtLeast(
  level: AccessLevel,
  required: AccessLevel
): boolean {
  return (
    ACCESS_LEVEL_ORDER.indexOf(level) >= ACCESS_LEVEL_ORDER.indexOf(required)
  );
}

/**
 * Lowest access level that may see unreleased events and unpublished recordings.
 */
export const UNRELEASED_VISIBILITY_ACCESS_LEVEL: AccessLevel = "VIEWER";

/**
 * Whether a grant sits below the level that may see unreleased material.
 *
 * Asked as an ordering question rather than as equality with the lowest level,
 * so that inserting a level below VIEWER scopes it like a listener instead of
 * silently granting it sight of everything.
 *
 * A null or undefined grant belongs either to a catalog admin, who is not scoped,
 * or to an actor with no access, who is refused before reaching any scoped query.
 * Both answer false.
 */
export function lacksUnreleasedVisibility(
  catalogGrant: AccessLevel | null | undefined
): boolean {
  return (
    catalogGrant != null &&
    !accessLevelAtLeast(catalogGrant, UNRELEASED_VISIBILITY_ACCESS_LEVEL)
  );
}
