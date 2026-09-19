import type { AccessLevel } from "@/generated/prisma/client";
import {
  permissionsForGrant,
  type CatalogGrant,
} from "@/lib/policy/catalog-permissions";

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
 * Whether a grant lacks the permission to see unreleased material, and so has to
 * be scoped to released events and published recordings.
 *
 * A null or undefined grant belongs either to a catalog admin, who is not scoped,
 * or to an actor with no access, who is refused before reaching any scoped query.
 * Both answer false, which is why this asks about the grant rather than calling
 * `grantHasPermission` with an administrator flag it does not have.
 */
export function lacksUnreleasedVisibility(
  catalogGrant: CatalogGrant | null | undefined
): boolean {
  return catalogGrant != null && !permissionsForGrant(catalogGrant).has("see_unreleased");
}
