"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { saveLastRoute } from "@/lib/pwa/last-route";

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
    saveLastRoute(search ? `${pathname}?${search}` : pathname);
  }, [pathname, search]);

  return null;
}
