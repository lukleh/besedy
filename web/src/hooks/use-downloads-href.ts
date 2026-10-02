"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { currentOrigin, withBackTo } from "@/lib/navigation/back-to";
import { DOWNLOADS_PATH } from "@/lib/offline/cache-names";

/** The Downloads link, which returns to the page it was opened from. */
export function useDownloadsHref(): string {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (!pathname || pathname === DOWNLOADS_PATH) return DOWNLOADS_PATH;
  return withBackTo(DOWNLOADS_PATH, currentOrigin(pathname, searchParams));
}
