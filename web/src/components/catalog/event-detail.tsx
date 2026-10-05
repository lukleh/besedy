"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarX, ChevronDown, Mic, RefreshCw } from "lucide-react";
import RecordingContent from "@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content";
import { formatPartialDate } from "@/lib/date-format";
import { fetchJson, isNetworkFailure } from "@/lib/api/fetch-json";
import { isAccessDeniedError } from "@/lib/query/auth-sensitive";
import { clearLastRoute } from "@/lib/pwa/last-route";
import { buildEventDetailUrl } from "@/lib/api/recording-urls";
import { readLocalEventDetail, withLocalFallback } from "@/lib/offline/local-source";
import { useLocalArtworkUrl } from "@/hooks/use-local-package";
import type { EventDetailResponse } from "@/types/event-detail";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { EventSequenceNavigation } from "@/components/catalog/event-sequence-navigation";
import { EventArtworkPicture } from "@/components/catalog/event-artwork-picture";
import { EventEditMenu } from "@/components/catalog/event-edit-menu";
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

  const { data, isLoading, error, refetch, isFetching } = useQuery<EventDetailResponse>({
    queryKey: ["catalog-event-detail", eventId],
    networkMode: "offlineFirst",
    // Network first; a complete local package answers when the request itself
    // cannot be made, so the same page renders online and offline.
    queryFn: () =>
      withLocalFallback(
        () => fetchJson<EventDetailResponse>(buildEventDetailUrl(catalogId, eventId)),
        () => readLocalEventDetail(catalogId, eventId)
      ),
  });
  // A hidden event is not worth resuming on at the next launch; the route was
  // recorded before this client-side answer arrived.
  const isHidden = isAccessDeniedError(error);
  useEffect(() => {
    if (isHidden) clearLastRoute();
  }, [isHidden]);
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
    // A hidden event answers 401, 403 or 404; either way there is nothing to retry.
    const isNotFound = isHidden;
    // The request could not be made, the browser says it is offline, and no
    // download answers it: not a server fault. Online, the same TypeError means
    // the server is unreachable and reads as a failed load.
    const isOffline =
      !isNotFound &&
      isNetworkFailure(error) &&
      typeof navigator !== "undefined" &&
      navigator.onLine === false;
    return (
      <EmptyState
        icon={CalendarX}
        title={isNotFound ? t("notFoundTitle") : t("loadErrorTitle")}
        description={
          isNotFound
            ? t("notFoundDescription")
            : isOffline
              ? tRoot("errors.offlineDescription")
              : tRoot("errors.serverErrorDescription")
        }
        actions={
          <>
            <Button asChild variant={isNotFound ? "default" : "outline"}>
              <Link href={`/catalog/${catalogId}?tab=events`}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t("backToEvents")}
              </Link>
            </Button>
            {!isNotFound && (
              <Button onClick={() => void refetch()} disabled={isFetching}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("retry")}
              </Button>
            )}
          </>
        }
      />
    );
  }

  const showRecorderMenu = data.recordings.length > 1;
  const selectedRecorderName = selectedRecording?.recorder?.name ?? t("unknownRecorder");
  const canViewArtworkCandidates = data.canViewArtworkCandidates ?? false;
  const canManageSources = data.canManageSources ?? false;
  const publishedArtwork = data.publishedArtwork ?? null;
  const artworkStatus = data.artworkStatus ?? "none";
  const latestDraftCandidate = data.latestDraftCandidate ?? null;

  // The draft preview below already labels itself, so the hint only needs to
  // cover the cases where there is nothing to show as an image.
  const artworkHint = !canViewArtworkCandidates
    ? null
    : publishedArtwork
      ? artworkStatus === "published-with-newer-drafts"
        ? t("newerDraftAvailable")
        : null
      : latestDraftCandidate
        ? null
        : tRoot("recording.noArtwork");

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

  // Released is the usual state, so only its absence is worth a badge.
  const eventBadges = (
    <>
      {!data.released && <Badge variant="secondary">{t("unreleased")}</Badge>}
      <SessionOrdinalBadge
        sessionOrdinal={data.sessionOrdinal}
        sessionCount={data.sessionCount}
      />
    </>
  );

  const editMenu = (
    <EventEditMenu
      catalogId={catalogId}
      eventId={eventId}
      canEditEvent={canEdit}
      metadataHash={data.canEditMetadata && selectedRecording ? selectedRecording.audioHash : null}
      metadataRecorderName={showRecorderMenu ? selectedRecorderName : null}
      canEditArtwork={canViewArtworkCandidates}
      artworkHint={artworkHint}
      canManageSources={canManageSources}
    />
  );

  // Saving the event for offline listening is the player's own control.
  const eventHeaderActions = (
    <>
      {eventBadges}
      {editMenu}
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

  // The event title is derived from its date and location, which the recording heading already shows.
  const description = data.description ? <p className="text-sm text-muted-foreground">{data.description}</p> : null;

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
        headingContext={{
          dateYear: data.dateYear,
          dateMonth: data.dateMonth,
          dateDay: data.dateDay,
          locationName: data.location?.name,
        }}
        headerActions={eventHeaderActions}
        headerIdentity={eventHeaderIdentity}
        hideDefaultRecorder
        hideMetadataEdit
        // The event route already validated catalog access on the server.
        skipCatalogValidation
        beforeAudioPlayer={artworkPicture}
        afterAudioPlayer={
          <div className="space-y-4">
            {eventNavigation}
            {description}
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
            {eventBadges}
          </div>
          <div className="shrink-0">{editMenu}</div>
        </div>

        {data.title && <p className="text-sm text-muted-foreground">{data.title}</p>}

        {description}
      </div>

      {artworkPicture}
      <div className="rounded-md border p-6 text-sm text-muted-foreground">{t("noRecordings")}</div>
      {eventNavigation}
    </div>
  );
}
