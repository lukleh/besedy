"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FolderOpen, Image as ImageIcon, Mic, Pencil } from "lucide-react";
import RecordingContent from "@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content";
import { formatPartialDate } from "@/lib/date-format";
import { fetchJson } from "@/lib/api/fetch-json";
import { buildEventDetailUrl } from "@/lib/api/recording-urls";
import { readLocalEventDetail, withLocalFallback } from "@/lib/offline/local-source";
import { useLocalArtworkUrl } from "@/hooks/use-local-package";
import type { EventDetailResponse } from "@/types/event-detail";
import { DownloadButton } from "@/components/offline/download-button";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EventSequenceNavigation } from "@/components/catalog/event-sequence-navigation";
import { EventArtworkPicture } from "@/components/catalog/event-artwork-picture";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";
import { SessionOrdinalBadge } from "./session-ordinal-badge";

interface EventDetailProps {
  catalogId: string;
  eventId: number;
  canEdit: boolean;
  showAllColumns: boolean;
  showReleaseState: boolean;
}

export function EventDetail({ catalogId, eventId, canEdit, showAllColumns, showReleaseState }: EventDetailProps) {
  const locale = useLocale();
  const t = useTranslations("events.detail");
  const tRoot = useTranslations();
  const tGuard = useTranslations("events.guard");
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedHash, setSelectedHash] = useState<string>("");
  const handledReadOnlyRef = useRef<string | null>(null);

  const { data, isLoading, error } = useQuery<EventDetailResponse>({
    queryKey: ["catalog-event-detail", eventId],
    // Network first; a complete local package answers when the request itself
    // cannot be made, so the same page renders online and offline.
    queryFn: () =>
      withLocalFallback(
        () => fetchJson<EventDetailResponse>(buildEventDetailUrl(catalogId, eventId)),
        () => readLocalEventDetail(catalogId, eventId)
      ),
  });
  const localArtworkUrl = useLocalArtworkUrl(catalogId, eventId, data?.publishedArtwork?.id ?? null);

  const defaultSelectedHash = useMemo(
    () => data?.recordings.find((recording) => recording.isPrimary)?.audioHash ?? data?.recordings[0]?.audioHash ?? "",
    [data]
  );

  const activeSelectedHash = useMemo(() => {
    if (!data) return "";
    return data.recordings.some((recording) => recording.audioHash === selectedHash)
      ? selectedHash
      : defaultSelectedHash;
  }, [data, selectedHash, defaultSelectedHash]);

  const selectedRecording = useMemo(
    () => data?.recordings.find((recording) => recording.audioHash === activeSelectedHash) ?? null,
    [data, activeSelectedHash]
  );

  useEffect(() => {
    const readOnlyFlag = searchParams.get("readOnly");
    if (readOnlyFlag !== "events") return;

    const currentPath = pathname ?? `/catalog/${catalogId}/event/${eventId}`;
    const currentSearch = searchParams.toString();
    const handledKey = `${currentPath}?${currentSearch}`;
    if (handledReadOnlyRef.current === handledKey) return;
    handledReadOnlyRef.current = handledKey;

    toast({
      title: tGuard("readOnlyTitle"),
      description: tGuard("readOnlyDescription"),
    });

    const nextParams = new URLSearchParams(currentSearch);
    nextParams.delete("readOnly");
    const nextQuery = nextParams.toString();
    const nextUrl = nextQuery ? `${currentPath}?${nextQuery}` : currentPath;
    router.replace(nextUrl, { scroll: false });
  }, [catalogId, eventId, pathname, router, searchParams, tGuard, toast]);

  if (isLoading) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6 space-y-4">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[420px] w-full rounded-lg" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 text-sm text-destructive">
        {t("loadError", {
          message: error instanceof Error ? error.message : t("unknownError"),
        })}
      </div>
    );
  }

  const recordingCountLabel = t("recordingCount", {
    count: data.recordings.length,
  });
  const showRecorderMenu = data.recordings.length > 1;
  const selectedRecorderName = selectedRecording?.recorder?.name ?? t("unknownRecorder");
  const canViewArtworkCandidates = data.canViewArtworkCandidates ?? false;
  const canManageSources = data.canManageSources ?? false;
  const publishedArtwork = data.publishedArtwork ?? null;
  const artworkStatus = data.artworkStatus ?? "none";
  const latestDraftCandidate = data.latestDraftCandidate ?? null;

  // The draft preview below already labels itself, so the badge only needs to
  // cover the cases where there is nothing to show as an image.
  const artworkStatusBadge = !canViewArtworkCandidates ? null : publishedArtwork ? (
    artworkStatus === "published-with-newer-drafts" ? (
      <Badge variant="secondary" className="self-start">
        {t("newerDraftAvailable")}
      </Badge>
    ) : null
  ) : latestDraftCandidate ? null : (
    <Badge variant="outline" className="self-start">
      {tRoot("recording.noArtwork")}
    </Badge>
  );

  const artworkAlt = data.title ?? t("eventFallbackTitle", { id: data.id });
  const artworkPicture = publishedArtwork ? (
    <EventArtworkPicture
      catalogId={catalogId}
      eventId={eventId}
      artworkId={publishedArtwork.id}
      alt={artworkAlt}
      fallbackSrc={localArtworkUrl}
    />
  ) : canViewArtworkCandidates && latestDraftCandidate ? (
    <div className="relative">
      <EventArtworkPicture
        catalogId={catalogId}
        eventId={eventId}
        artworkId={latestDraftCandidate.id}
        alt={artworkAlt}
        source="candidate"
      />
      <Badge variant="secondary" className="absolute left-3 top-3 shadow-sm">
        {t("draftArtworkAvailable")}
      </Badge>
    </div>
  ) : null;

  const eventHeaderActions = (
    <>
      {data.recordings.length > 0 && <DownloadButton catalogId={catalogId} eventId={eventId} size="default" />}
      {data.released ? <Badge>{t("released")}</Badge> : <Badge variant="secondary">{t("unreleased")}</Badge>}
      <SessionOrdinalBadge
        sessionOrdinal={data.sessionOrdinal}
        sessionCount={data.sessionCount}
      />
      <Badge variant="outline">{recordingCountLabel}</Badge>
      {canEdit && (
        <Button asChild variant="outline" size="sm">
          <Link href={`/catalog/${catalogId}/event/${eventId}/edit`}>
            <Pencil className="mr-2 h-4 w-4" />
            {t("editEvent")}
          </Link>
        </Button>
      )}
    </>
  );

  const eventHeaderIdentity = selectedRecording ? (
    showRecorderMenu ? (
      <ResponsiveMenu>
        <ResponsiveMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="max-w-full justify-start sm:justify-end"
            aria-label={t("selectRecorder")}
          >
            <Mic className="mr-2 h-4 w-4 shrink-0" />
            <span className="truncate">{selectedRecorderName}</span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0" />
          </Button>
        </ResponsiveMenuTrigger>
        <ResponsiveMenuContent align="end" title={t("recordingsMenuTitle")}>
          <ResponsiveMenuRadioGroup value={activeSelectedHash} onValueChange={(value) => setSelectedHash(value)}>
            {data.recordings.map((recording) => (
              <ResponsiveMenuRadioItem key={recording.audioHash} value={recording.audioHash}>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="truncate">{recording.recorder?.name ?? t("unknownRecorder")}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {recording.durationHms ?? "--:--:--"}
                  </span>
                </div>
              </ResponsiveMenuRadioItem>
            ))}
          </ResponsiveMenuRadioGroup>
        </ResponsiveMenuContent>
      </ResponsiveMenu>
    ) : (
      <div className="inline-flex max-w-full items-center gap-2 text-sm text-muted-foreground">
        <Mic className="h-4 w-4 shrink-0" />
        <span className="truncate">{selectedRecorderName}</span>
      </div>
    )
  ) : null;

  const detailExtras =
    canViewArtworkCandidates || canManageSources || data.title || data.description ? (
      <div className="space-y-3">
        {artworkStatusBadge}
        {(canViewArtworkCandidates || canManageSources) && (
          <div className="flex flex-wrap items-center gap-2">
            {canViewArtworkCandidates && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/catalog/${catalogId}/event/${eventId}/artwork`}>
                  <ImageIcon className="h-4 w-4 mr-2" />
                  {tRoot("recording.editArtwork")}
                </Link>
              </Button>
            )}
            {canManageSources && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/catalog/${catalogId}/event/${eventId}/sources`}>
                  <FolderOpen className="h-4 w-4 mr-2" />
                  {tRoot("recording.sourcesTitle")}
                </Link>
              </Button>
            )}
          </div>
        )}
        {(data.title || data.description) && (
          <div className="space-y-1 text-sm text-muted-foreground">
            {data.title && <p>{data.title}</p>}
            {data.description && <p>{data.description}</p>}
          </div>
        )}
      </div>
    ) : null;

  const eventNavigation = (
    <EventSequenceNavigation
      catalogId={catalogId}
      eventId={eventId}
      showAllColumns={showAllColumns}
      showReleaseState={showReleaseState}
    />
  );

  if (selectedRecording) {
    return (
      <RecordingContent
        key={selectedRecording.audioHash}
        params={{ catalogId, hash: selectedRecording.audioHash }}
        downloadEventId={eventId}
        headerActions={eventHeaderActions}
        headerIdentity={eventHeaderIdentity}
        hideDefaultRecorder
        // The event route already validated catalog access on the server.
        skipCatalogValidation
        beforeAudioPlayer={artworkPicture}
        afterAudioPlayer={
          <div className="space-y-4">
            {eventNavigation}
            {detailExtras}
          </div>
        }
      />
    );
  }

  const formattedDate = formatPartialDate(data.dateYear, data.dateMonth, data.dateDay, locale) ?? String(data.dateYear);
  const locationName = data.location?.name ?? t("unknownLocation");

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6 space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">
              {formattedDate} · {locationName}
            </h1>
            {data.released ? <Badge>{t("released")}</Badge> : <Badge variant="secondary">{t("unreleased")}</Badge>}
            <SessionOrdinalBadge
              sessionOrdinal={data.sessionOrdinal}
              sessionCount={data.sessionCount}
            />
            <Badge variant="outline">{recordingCountLabel}</Badge>
          </div>
          {canEdit && (
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href={`/catalog/${catalogId}/event/${eventId}/edit`}>
                <Pencil className="mr-2 h-4 w-4" />
                {t("editEvent")}
              </Link>
            </Button>
          )}
        </div>

        {data.title && <p className="text-sm text-muted-foreground">{data.title}</p>}

        {data.description && <p className="text-sm text-muted-foreground">{data.description}</p>}

        {(canViewArtworkCandidates || canManageSources) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {canViewArtworkCandidates && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/catalog/${catalogId}/event/${eventId}/artwork`}>
                  <ImageIcon className="h-4 w-4 mr-2" />
                  {tRoot("recording.editArtwork")}
                </Link>
              </Button>
            )}
            {canManageSources && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/catalog/${catalogId}/event/${eventId}/sources`}>
                  <FolderOpen className="h-4 w-4 mr-2" />
                  {tRoot("recording.sourcesTitle")}
                </Link>
              </Button>
            )}
          </div>
        )}
      </div>

      {artworkStatusBadge}
      {artworkPicture}
      <div className="rounded-md border p-6 text-sm text-muted-foreground">{t("noRecordings")}</div>
      {eventNavigation}
    </div>
  );
}
