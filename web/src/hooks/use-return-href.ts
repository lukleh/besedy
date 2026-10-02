"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  BACK_TO_PARAM,
  currentOrigin,
  pathnameOf,
  withBackTo,
} from "@/lib/navigation/back-to";

/**
 * A link to a page opened from anywhere (Downloads, Settings, catalog
 * settings) whose back control returns to the page it was opened from.
 */
export function useReturnHref(target: string): string {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (!pathname) return target;
  if (pathname === pathnameOf(target)) {
    // Already there: keep the page's own origin rather than dropping it.
    const backTo = searchParams?.get(BACK_TO_PARAM);
    return backTo ? withBackTo(target, backTo) : target;
  }
  return withBackTo(target, currentOrigin(pathname, searchParams));
}
