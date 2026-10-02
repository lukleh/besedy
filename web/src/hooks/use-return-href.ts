"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { currentOrigin, withBackTo } from "@/lib/navigation/back-to";

/**
 * A link to a page opened from anywhere (Downloads, Settings, catalog
 * settings) whose back control returns to the page it was opened from.
 */
export function useReturnHref(target: string): string {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const targetPathname = target.split(/[?#]/, 1)[0];
  if (!pathname || pathname === targetPathname) return target;
  return withBackTo(target, currentOrigin(pathname, searchParams));
}
