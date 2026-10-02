import { resolveAppPagePath } from "@/lib/auth/oauth-routing";
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
 * and search passage, the radio handoff, the read-only notice, the admin Add
 * user dialog. Returning to the page must not replay them, so the origin
 * leaves them out. Parameters that describe the page (tab, filters) stay.
 */
const ONE_SHOT_PARAMS = [
  BACK_TO_PARAM,
  "seek",
  "end",
  "fromSearch",
  "fromRadio",
  "readOnly",
  "action",
];

const URL_BASE = "http://besedy.local";

/** The path of an app-relative link, without its query or hash. */
export function pathnameOf(href: string): string {
  return href.split(/[?#]/, 1)[0];
}

/** The app page to return to, or null when the value is unusable. */
export function resolveBackToPath(value: string | null | undefined): string | null {
  const page = resolveAppPagePath(value);
  if (!page) return null;
  // The warm-up request for the offline shell is not a page to return to.
  const url = new URL(page, URL_BASE);
  const isShellWarmup = url.pathname === DOWNLOADS_PATH && url.searchParams.has("warm");
  return isShellWarmup ? null : page;
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
