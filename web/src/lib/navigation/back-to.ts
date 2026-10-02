import { normalizeAppRelativePath } from "@/lib/auth/oauth-routing";

/**
 * Query parameter naming the page a link was followed from, for pages whose
 * fixed parent is not where the listener came from (a Downloads card opening
 * an event, the Downloads icon opened from a recording). It holds one step:
 * the origin is recorded without its own back target, so pressing back climbs
 * to the catalog list instead of replaying a trail.
 */
export const BACK_TO_PARAM = "backTo";

const DISALLOWED_BACK_NAMESPACES = ["/api", "/auth"];

/** The app-relative page to return to, or null when the value is unusable. */
export function resolveBackToPath(value: string | null | undefined): string | null {
  const normalized = normalizeAppRelativePath(value);
  if (!normalized) return null;
  const pathname = normalized.split(/[?#]/, 1)[0];
  const disallowed = DISALLOWED_BACK_NAMESPACES.some(
    (namespace) => pathname === namespace || pathname.startsWith(`${namespace}/`)
  );
  return disallowed ? null : normalized;
}

/** The current page as an origin: its path and query without its own back target. */
export function currentOrigin(
  pathname: string,
  searchParams: { toString(): string } | null | undefined
): string {
  const params = new URLSearchParams(searchParams?.toString() ?? "");
  params.delete(BACK_TO_PARAM);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** Adds the origin to a link, keeping any query the link already has. */
export function withBackTo(href: string, origin: string): string {
  const [pathAndQuery, hash] = href.split("#", 2);
  const [path, query = ""] = pathAndQuery.split("?", 2);
  const params = new URLSearchParams(query);
  params.set(BACK_TO_PARAM, origin);
  return `${path}?${params.toString()}${hash !== undefined ? `#${hash}` : ""}`;
}
