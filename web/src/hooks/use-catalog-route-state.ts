"use client";

import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { sanitizeAppRelativePath } from "@/lib/auth/oauth-routing";

export interface CatalogRouteLabels {
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
  backTargetUrl: string;
  backTargetLabel: string;
}

interface CatalogRouteStateOptions {
  backToPath?: string | null;
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
  const backToCatalogUrl = routeGroupId ? `/catalog/${routeGroupId}` : "/catalog";
  const backToEventsUrl = routeGroupId
    ? `/catalog/${routeGroupId}?tab=events`
    : "/catalog?tab=events";
  const explicitBackTargetUrl =
    isRecordingRoute && !isRecordingSubpage && options?.backToPath
      ? sanitizeAppRelativePath(options.backToPath)
      : null;
  const backTargetUrl =
    isRecordingSubpage && routeGroupId && recordingHash
      ? `/catalog/${routeGroupId}/recording/${recordingHash}`
      : explicitBackTargetUrl
        ? explicitBackTargetUrl
      : isRecordingRoute
        ? backToCatalogUrl
        : isEventSubpage && routeGroupId && eventId
          ? `/catalog/${routeGroupId}/event/${eventId}`
          : isEventRoute
            ? backToEventsUrl
            : backToCatalogUrl;
  const backTargetLabel = isRecordingSubpage
    ? labels.backToRecording
    : isEventSubpage
      ? labels.backToEvent
      : labels.backToCatalog;

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
    backTargetUrl,
    backTargetLabel,
  };
}

export function useCatalogRouteState(): CatalogRouteState {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tRecording = useTranslations("recording");
  const backToPath = searchParams.get("backTo");

  return useMemo(
    () =>
      buildCatalogRouteState(
        pathname,
        {
          backToCatalog: tRecording("backToCatalog"),
          backToRecording: tRecording("backToRecording"),
          backToEvent: tRecording("backToEvent"),
        },
        { backToPath }
      ),
    [backToPath, pathname, tRecording]
  );
}
