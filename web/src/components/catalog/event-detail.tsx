"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import NextImage from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FolderOpen, Image as ImageIcon, Mic, Pencil } from "lucide-react";
import RecordingContent from "@/app/catalog/[catalogId]/recording/[hash]/recording-content";
import { formatPartialDate } from "@/lib/date-format";
import { fetchJson } from "@/lib/api/fetch-json";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";

interface EventDetailProps {
  catalogId: string;
  eventId: number;
  canEdit: boolean;
}

interface EventRecording {
  audioHash: string;
  isPrimary: boolean;
  sortOrder: number;
  title: string;
  artist: string | null;
  durationHms: string | null;
  verified: boolean;
  recorder: { id: number; name: string } | null;
}

interface EventDetailResponse {
  id: number;
  workflowGroupId: string;
  title: string | null;
  location: { id: number; name: string } | null;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  sessionIndex: number;
  description: string | null;
  released: boolean;
  recordings: EventRecording[];
  canManagePosters?: boolean;
  canManageSources?: boolean;
  posterStatus?: {
    portrait: boolean;
    landscape: boolean;
  } | null;
  posterFiles?: {
    portrait: { exists: boolean; filename: string | null; uploadedAt?: string | null; size?: number | null };
    landscape: { exists: boolean; filename: string | null; uploadedAt?: string | null; size?: number | null };
  } | null;
}

export function EventDetail({ catalogId, eventId, canEdit }: EventDetailProps) {
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
    queryFn: () =>
      fetchJson<EventDetailResponse>(`/api/catalogs/${catalogId}/events/${eventId}`),
  });

  const defaultSelectedHash = useMemo(
    () =>
      data?.recordings.find((recording) => recording.isPrimary)?.audioHash ??
      data?.recordings[0]?.audioHash ??
      "",
    [data]
  );

  const activeSelectedHash = useMemo(() => {
    if (!data) return "";
    return data.recordings.some((recording) => recording.audioHash === selectedHash)
      ? selectedHash
      : defaultSelectedHash;
  }, [data, selectedHash, defaultSelectedHash]);

  const selectedRecording = useMemo(
    () =>
      data?.recordings.find((recording) => recording.audioHash === activeSelectedHash) ??
      null,
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

  const recordingCountLabel = t("recordingCount", { count: data.recordings.length });
  const showRecorderMenu = data.recordings.length > 1;
  const selectedRecorderName = selectedRecording?.recorder?.name ?? t("unknownRecorder");
  const canManagePosters = data.canManagePosters ?? false;
  const canManageSources = data.canManageSources ?? false;
  const posterStatus = data.posterStatus;
  const posterFiles = data.posterFiles;
  const posterPortraitExists = posterFiles?.portrait.exists ?? posterStatus?.portrait ?? false;
  const posterLandscapeExists = posterFiles?.landscape.exists ?? posterStatus?.landscape ?? false;
  const hasAnyPoster = posterPortraitExists || posterLandscapeExists;
  const posterPortraitVersion = posterFiles?.portrait.uploadedAt;
  const posterLandscapeVersion = posterFiles?.landscape.uploadedAt;
  const portraitPosterSrc = `/api/catalogs/${catalogId}/events/${eventId}/poster?variant=portrait${posterPortraitVersion ? `&v=${encodeURIComponent(posterPortraitVersion)}` : ""}`;
  const landscapePosterSrc = `/api/catalogs/${catalogId}/events/${eventId}/poster?variant=landscape${posterLandscapeVersion ? `&v=${encodeURIComponent(posterLandscapeVersion)}` : ""}`;

  const eventHeaderActions = (
    <>
      {data.released ? <Badge>{t("released")}</Badge> : <Badge variant="secondary">{t("unreleased")}</Badge>}
      {data.sessionIndex > 1 ? (
        <Badge variant="outline">{t("sessionLabel", { index: data.sessionIndex })}</Badge>
      ) : null}
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
          <ResponsiveMenuRadioGroup
            value={activeSelectedHash}
            onValueChange={(value) => setSelectedHash(value)}
          >
            {data.recordings.map((recording) => (
              <ResponsiveMenuRadioItem key={recording.audioHash} value={recording.audioHash}>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="truncate">
                    {recording.recorder?.name ?? t("unknownRecorder")}
                  </span>
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
    hasAnyPoster || canManagePosters || canManageSources || data.title || data.description ? (
      <div className="space-y-3">
        {posterPortraitExists && (
          <div className="sm:hidden">
            <NextImage
              src={portraitPosterSrc}
              alt={data.title ?? t("eventFallbackTitle", { id: data.id })}
              width={900}
              height={1600}
              className="w-full rounded-xl border border-border/50 bg-muted"
              unoptimized
            />
          </div>
        )}
        {posterLandscapeExists && (
          <div className="hidden sm:block">
            <NextImage
              src={landscapePosterSrc}
              alt={data.title ?? t("eventFallbackTitle", { id: data.id })}
              width={1600}
              height={900}
              className="w-full rounded-xl border border-border/50 bg-muted"
              unoptimized
            />
          </div>
        )}
        {!hasAnyPoster && canManagePosters && (
          <Badge variant="outline" className="self-start">
            {tRoot("recording.noPoster")}
          </Badge>
        )}
        {(canManagePosters || canManageSources) && (
          <div className="flex flex-wrap items-center gap-2">
            {canManagePosters && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/catalog/${catalogId}/event/${eventId}/poster`}>
                  <ImageIcon className="h-4 w-4 mr-2" />
                  {tRoot("recording.editPoster")}
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

  if (selectedRecording) {
    return (
      <RecordingContent
        key={selectedRecording.audioHash}
        params={{ catalogId, hash: selectedRecording.audioHash }}
        headerActions={eventHeaderActions}
        headerIdentity={eventHeaderIdentity}
        hideDefaultRecorder
        afterAudioPlayer={detailExtras}
      />
    );
  }

  const formattedDate =
    formatPartialDate(data.dateYear, data.dateMonth, data.dateDay, locale) ?? String(data.dateYear);
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
            {data.sessionIndex > 1 ? (
              <Badge variant="outline">{t("sessionLabel", { index: data.sessionIndex })}</Badge>
            ) : null}
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

        {data.title && (
          <p className="text-sm text-muted-foreground">{data.title}</p>
        )}

        {data.description && (
          <p className="text-sm text-muted-foreground">{data.description}</p>
        )}

        {(canManagePosters || canManageSources) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {canManagePosters && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/catalog/${catalogId}/event/${eventId}/poster`}>
                  <ImageIcon className="h-4 w-4 mr-2" />
                  {tRoot("recording.editPoster")}
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

      <div className="rounded-md border p-6 text-sm text-muted-foreground">
        {t("noRecordings")}
      </div>
    </div>
  );
}
