import { normalizeAppRelativePath } from "@/lib/auth/oauth-routing";
import { DOWNLOADS_PATH } from "@/lib/offline/cache-names";

/**
 * Query parameter naming the page a link was followed from, for pages whose
 * fixed parent is not where the listener came from (a Downloads card opening
 * an event, Downloads or Settings opened from a recording). It holds one step:
 * the origin is recorded without its own back target, so pressing back climbs
 * to the catalog list instead of replaying a trail.
 */
export const BACK_TO_PARAM = "backTo";

/**
 * Parameters that act once when a page opens: the recording's start position
 * and search passage, the radio handoff, the read-only notice. Returning to
 * the page must not replay them, so the origin leaves them out.
 */
const ONE_SHOT_PARAMS = [BACK_TO_PARAM, "seek", "end", "fromSearch", "fromRadio", "readOnly"];

const DISALLOWED_BACK_NAMESPACES = ["/api", "/auth"];
const URL_BASE = "http://besedy.local";

/** The app-relative page to return to, or null when the value is unusable. */
export function resolveBackToPath(value: string | null | undefined): string | null {
  const normalized = normalizeAppRelativePath(value);
  if (!normalized) return null;
  const url = new URL(normalized, URL_BASE);
  const disallowed = DISALLOWED_BACK_NAMESPACES.some(
    (namespace) => url.pathname === namespace || url.pathname.startsWith(`${namespace}/`)
  );
  // The warm-up request for the offline shell is not a page to return to.
  const isShellWarmup = url.pathname === DOWNLOADS_PATH && url.searchParams.has("warm");
  return disallowed || isShellWarmup ? null : normalized;
}

/** The current page as an origin: its path and the query that describes it. */
export function currentOrigin(
  pathname: string,
  searchParams: { toString(): string } | null | undefined
): string {
  const params = new URLSearchParams(searchParams?.toString() ?? "");
  for (const name of ONE_SHOT_PARAMS) params.delete(name);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** Adds the origin to an app-relative link, keeping its query and hash. */
export function withBackTo(href: string, origin: string): string {
  const url = new URL(href, URL_BASE);
  url.searchParams.set(BACK_TO_PARAM, origin);
  return `${url.pathname}${url.search}${url.hash}`;
}
