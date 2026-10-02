"use client";

import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { BACK_TO_PARAM, resolveBackToPath } from "@/lib/navigation/back-to";

export interface CatalogRouteLabels {
  back: string;
  backToCatalog: string;
  backToRecording: string;
  backToEvent: string;
}

export interface CatalogRouteState {
  pathname: string | null;
  pathSegments: string[];
  isAuthPage: boolean;
  routeGroupId: string | null;
  isRecordingRoute: boolean;
  isEventRoute: boolean;
  isDetailRoute: boolean;
  recordingHash: string | null;
  eventId: string | null;
  isRecordingSubpage: boolean;
  isEventSubpage: boolean;
  /**
   * Where the header back control leads, or null on a home page (the catalog
   * list and the pages above it, admin and auth pages), which show the logo.
   */
  backTargetUrl: string | null;
  backTargetLabel: string;
}

export interface CatalogRouteStateOptions {
  backToPath?: string | null;
  /**
   * The Downloads library is the home page: offline, where the catalog list
   * opens the library itself, and for a listener who is not signed in.
   */
  downloadsIsHome?: boolean;
}

interface BackTarget {
  url: string | null;
  label: keyof CatalogRouteLabels;
}

/**
 * The page above the current one. Null for pages without a back control;
 * a null url with a label marks a page that shows the control only when an
 * explicit origin is given.
 */
function resolveParent(
  segments: string[],
  downloadsIsHome: boolean
): BackTarget | null {
  const [root, catalogId, section, id] = segments;
  if (root === "downloads" && segments.length === 1) {
    return { url: downloadsIsHome ? null : "/catalog", label: "backToCatalog" };
  }
  if (root === "settings" && segments.length === 1) {
    return { url: "/catalog", label: "backToCatalog" };
  }
  if (root !== "catalog" || !catalogId || !section) return null;

  const catalogUrl = `/catalog/${catalogId}`;
  const eventsUrl = `${catalogUrl}?tab=events`;
  switch (section) {
    case "recording":
      if (!id) return null;
      return segments.length > 4
        ? { url: `${catalogUrl}/recording/${id}`, label: "backToRecording" }
        : { url: catalogUrl, label: "backToCatalog" };
    case "event":
      if (!id) return null;
      return segments.length > 4
        ? { url: `${catalogUrl}/event/${id}`, label: "backToEvent" }
        : { url: eventsUrl, label: "backToCatalog" };
    case "events":
      return id === "unassigned" && segments.length === 4
        ? { url: eventsUrl, label: "backToCatalog" }
        : null;
    case "settings":
      return segments.length === 3 ? { url: catalogUrl, label: "backToCatalog" } : null;
    case "deep-search":
      if (segments.length === 3) return { url: catalogUrl, label: "backToCatalog" };
      return segments.length === 4 ? { url: `${catalogUrl}/deep-search`, label: "back" } : null;
    default:
      return null;
  }
}

export function buildCatalogRouteState(
  pathname: string | null | undefined,
  labels: CatalogRouteLabels,
  options?: CatalogRouteStateOptions
): CatalogRouteState {
  const normalizedPathname = pathname ?? null;
  const pathSegments = normalizedPathname?.split("/").filter(Boolean) ?? [];
  const isAuthPage = normalizedPathname?.startsWith("/auth") ?? false;
  const routeGroupId =
    pathSegments.length >= 2 && pathSegments[0] === "catalog"
      ? pathSegments[1]
      : null;
  const isRecordingRoute =
    pathSegments.length >= 3 &&
    pathSegments[0] === "catalog" &&
    pathSegments[2] === "recording";
  const isEventRoute =
    pathSegments.length >= 3 &&
    pathSegments[0] === "catalog" &&
    pathSegments[2] === "event";
  const isDetailRoute = isRecordingRoute || isEventRoute;
  const recordingHash = isRecordingRoute && pathSegments.length >= 4 ? pathSegments[3] : null;
  const eventId = isEventRoute && pathSegments.length >= 4 ? pathSegments[3] : null;
  const isRecordingSubpage = isRecordingRoute && pathSegments.length > 4;
  const isEventSubpage = isEventRoute && pathSegments.length > 4;

  const parent = resolveParent(pathSegments, options?.downloadsIsHome ?? false);
  const origin = parent ? resolveBackToPath(options?.backToPath) : null;
  const originPathname = origin?.split(/[?#]/, 1)[0];
  const backTarget: BackTarget | null =
    origin && originPathname !== normalizedPathname
      ? { url: origin, label: "back" }
      : parent;

  return {
    pathname: normalizedPathname,
    pathSegments,
    isAuthPage,
    routeGroupId,
    isRecordingRoute,
    isEventRoute,
    isDetailRoute,
    recordingHash,
    eventId,
    isRecordingSubpage,
    isEventSubpage,
    backTargetUrl: backTarget?.url ?? null,
    backTargetLabel: labels[backTarget?.label ?? "back"],
  };
}

export function useCatalogRouteState(
  options?: Pick<CatalogRouteStateOptions, "downloadsIsHome">
): CatalogRouteState {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tNav = useTranslations("nav");
  const tRecording = useTranslations("recording");
  const backToPath = searchParams.get(BACK_TO_PARAM);
  const downloadsIsHome = options?.downloadsIsHome ?? false;

  return useMemo(
    () =>
      buildCatalogRouteState(
        pathname,
        {
          back: tNav("back"),
          backToCatalog: tRecording("backToCatalog"),
          backToRecording: tRecording("backToRecording"),
          backToEvent: tRecording("backToEvent"),
        },
        { backToPath, downloadsIsHome }
      ),
    [backToPath, downloadsIsHome, pathname, tNav, tRecording]
  );
}
