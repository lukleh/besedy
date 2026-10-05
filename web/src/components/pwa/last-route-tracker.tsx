"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { NOT_FOUND_PAGE_ATTRIBUTE, saveLastRoute } from "@/lib/pwa/last-route";

/**
 * Records the page the listener has open so the installed app can resume
 * there on its next launch. Renders nothing.
 */
export function LastRouteTracker() {
  return (
    <Suspense fallback={null}>
      <LastRouteRecorder />
    </Suspense>
  );
}

function LastRouteRecorder() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";

  useEffect(() => {
    if (!pathname) return;
    // The page is already in the DOM when this effect runs. A not-found page
    // (a missing catalog or event, an unmatched URL) is not worth resuming on.
    if (document.querySelector(`[${NOT_FOUND_PAGE_ATTRIBUTE}]`)) return;
    saveLastRoute(search ? `${pathname}?${search}` : pathname);
  }, [pathname, search]);

  return null;
}
