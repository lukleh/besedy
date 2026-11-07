import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireArchive } from "@/lib/archive";
import { getSession } from "@/lib/auth/session";
import {
  getCatalogCapability,
} from "@/lib/access/capabilities";
import {
  LAST_ROUTE_COOKIE,
  PWA_LAUNCH_PARAM,
  PWA_LAUNCH_VALUE,
  resolveRestorableRoute,
} from "@/lib/pwa/last-route";

type SearchParams = Record<string, string | string[] | undefined>;

function buildQuerySuffix(searchParams?: SearchParams): string {
  if (!searchParams) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    // The launch marker is handled here and must not follow the redirect.
    if (key === PWA_LAUNCH_PARAM) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === "string" && item.length > 0) {
          params.append(key, item);
        }
      });
    } else if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export default async function CatalogIndexPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const querySuffix = buildQuerySuffix(resolvedSearchParams);
  const session = await getSession();

  if (!session?.user) {
    redirect("/auth/signin");
  }

  const archive = await requireArchive();
  const capability = await getCatalogCapability(archive.id, session.user.id);
  if (!capability.hasAccess) {
    redirect("/auth/no-access");
  }

  // Resume only inside the configured archive or source-neutral settings.
  if (resolvedSearchParams?.[PWA_LAUNCH_PARAM] === PWA_LAUNCH_VALUE) {
    const cookieStore = await cookies();
    const lastRoute = resolveRestorableRoute(cookieStore.get(LAST_ROUTE_COOKIE)?.value);
    const savedPath = lastRoute?.split("?", 1)[0];
    if (lastRoute && (
      savedPath === "/settings" || savedPath?.startsWith("/settings/") ||
      savedPath === `/catalog/${archive.id}` ||
      savedPath?.startsWith(`/catalog/${archive.id}/`)
    )) {
      redirect(lastRoute);
    }
  }

  redirect(`/catalog/${archive.id}${querySuffix}`);
}
