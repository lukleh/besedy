import { sanitizeAppRelativePath } from "@/lib/auth/oauth-routing";

/**
 * The installed app resumes on the page the listener last had open.
 *
 * The (app) layout records each page in a cookie, and the manifest's
 * start_url carries a launch marker. The /catalog index page redirects a
 * marked launch to the recorded page on the server, so there is no flash of
 * the catalog list. Unmarked visits to /catalog (the Library link,
 * notifications, sign-in) keep landing on the list.
 */

export const LAST_ROUTE_COOKIE = "besedy_last_route";
export const PWA_LAUNCH_PARAM = "launch";
export const PWA_LAUNCH_VALUE = "pwa";

const LAST_ROUTE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const LAST_ROUTE_MAX_LENGTH = 2048;
const RESTORABLE_NAMESPACES = ["/catalog/", "/settings"];

/**
 * Returns the app-relative route when it is one the app may resume on, or
 * null. The bare /catalog index is excluded so a launch cannot redirect to
 * itself; auth, API, admin and the offline /downloads shell are excluded.
 */
export function resolveRestorableRoute(route: string | null | undefined): string | null {
  if (!route || route.length > LAST_ROUTE_MAX_LENGTH) return null;

  // Unsafe input sanitizes to the bare /catalog index, which is not restorable.
  const sanitized = sanitizeAppRelativePath(route);
  const withoutHash = sanitized.split("#", 1)[0];
  const pathname = withoutHash.split("?", 1)[0];
  const isRestorable = RESTORABLE_NAMESPACES.some((namespace) =>
    namespace.endsWith("/")
      ? pathname.startsWith(namespace) && pathname.length > namespace.length
      : pathname === namespace || pathname.startsWith(`${namespace}/`)
  );
  return isRestorable ? withoutHash : null;
}

function writeCookie(value: string, maxAgeSeconds: number) {
  const secure = window.location.protocol === "https:" ? ";secure" : "";
  document.cookie = `${LAST_ROUTE_COOKIE}=${value};path=/;max-age=${maxAgeSeconds};samesite=lax${secure}`;
}

/** Records the current route in the browser; ignores routes it may not resume on. */
export function saveLastRoute(route: string) {
  if (typeof document === "undefined") return;
  const restorable = resolveRestorableRoute(route);
  if (!restorable) return;
  try {
    writeCookie(encodeURIComponent(restorable), LAST_ROUTE_MAX_AGE_SECONDS);
  } catch {
    // Cookies may be blocked; resuming is best-effort.
  }
}

export function clearLastRoute() {
  if (typeof document === "undefined") return;
  try {
    writeCookie("", 0);
  } catch {
    // Cookies may be blocked; nothing to clear.
  }
}
