"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, Download, FileAudio, Mic, Music, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import { AudioPlayer } from "@/components/player/audio-player";
import { TranscriptStreamViewer } from "@/components/transcript/transcript-stream-viewer";
import { TranscriptViewer } from "@/components/transcript/transcript-viewer";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";
import { cn } from "@/lib/utils";
import { formatMediumDate } from "@/lib/date-format";
import type { CatalogEntryResponse } from "@/types/catalog";
import type { RecordingSeekRequest } from "./use-recording-playback";

interface RecordingPermissions {
  canDownload?: boolean;
  canEditMetadata?: boolean;
}

interface RecordingAudioSourceOption {
  available: boolean;
  id: string;
  label: string;
}

type RecordingPageStateVariant =
  | "catalogNotFound"
  | "recordingNotFound"
  | "recordingUnavailable";

interface RecordingPageStateProps {
  afterAudioPlayer?: ReactNode;
  backToListUrl: string;
  catalogId: string;
  variant: RecordingPageStateVariant;
}

interface RecordingHeaderProps {
  hash: string;
  headerActions?: ReactNode;
  headerIdentity?: ReactNode;
  hideDefaultRecorder?: boolean;
  recording: CatalogEntryResponse;
}

interface RecordingAudioSectionProps {
  afterAudioPlayer?: ReactNode;
  audioSource: string;
  audioUrl: string;
  autoPlayOnSeek: boolean;
  catalogId: string;
  currentTimeSetter: (time: number) => void;
  hash: string;
  onAudioDownload: (source: "archived" | "original") => void;
  onAudioEnded: (duration: number) => void;
  onDurationChange: (duration: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onSourceChange: (sourceId: string) => void;
  permissions: RecordingPermissions;
  recording: CatalogEntryResponse;
  savedSourceId: string | null;
  seekRequest?: RecordingSeekRequest;
  sources: RecordingAudioSourceOption[];
}

interface RecordingTranscriptSectionProps {
  canDownload?: boolean;
  catalogId: string;
  currentTime: number;
  hash: string;
  isPlaying: boolean;
  onSeek: (time: number) => void;
  onToggleTranscriptStream: (value: boolean) => void;
  showTranscriptStream: boolean;
}

export function RecordingPageSkeleton() {
  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6">
      <Skeleton className="h-4 w-32 mb-4" />
      <Skeleton className="h-8 w-64 mb-2" />
      <Skeleton className="h-4 w-48 mb-2" />
      <Skeleton className="h-3 w-72 mb-6" />
      <div className="space-y-4 mb-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-[400px] w-full rounded-lg" />
      </div>
    </div>
  );
}

export function RecordingPageState({
  afterAudioPlayer,
  backToListUrl,
  catalogId,
  variant,
}: RecordingPageStateProps) {
  const t = useTranslations();
  const backHref = variant === "catalogNotFound" ? "/catalog" : backToListUrl;
  const title =
    variant === "catalogNotFound"
      ? t("catalog.invalidTitle")
      : variant === "recordingUnavailable"
        ? t("recording.unavailable")
        : t("recording.notFound");
  const description =
    variant === "catalogNotFound"
      ? t("catalog.invalidDescription", { id: catalogId })
      : variant === "recordingUnavailable"
        ? t("recording.unavailableDescription")
        : t("recording.notFoundDescription");

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6">
      <Link
        href={backHref}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("recording.backToCatalog")}
      </Link>
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FileAudio className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground mt-2">{description}</p>
      </div>
      {afterAudioPlayer && <div className="mt-4">{afterAudioPlayer}</div>}
    </div>
  );
}

export function RecordingHeader({
  hash,
  headerActions,
  headerIdentity,
  hideDefaultRecorder = false,
  recording,
}: RecordingHeaderProps) {
  const locale = useLocale();
  const hasFullDate = recording.dateYear && recording.dateMonth && recording.dateDay;
  const hasLocation = !!recording.location?.name;
  const useContextTitle = hasFullDate && hasLocation;
  const formattedDate = hasFullDate
    ? formatMediumDate(recording.dateYear!, recording.dateMonth!, recording.dateDay!, locale)
    : null;
  const fallbackTitle =
    recording.curatedTitle || recording.title || recording.filename || hash.slice(0, 16);
  const defaultRecorderIdentity = recording.recorder && !hideDefaultRecorder ? (
    <div className="inline-flex max-w-full items-center gap-2 text-sm text-muted-foreground">
      <Mic className="h-4 w-4 shrink-0" />
      <span className="truncate">{recording.recorder.name}</span>
    </div>
  ) : null;
  const resolvedHeaderIdentity = headerIdentity ?? defaultRecorderIdentity;

  return (
    <div className="flex flex-col gap-3 mb-4 sm:mb-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="space-y-2 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">
            {useContextTitle ? (
              <>
                <span className="block sm:inline">{formattedDate}</span>
                <span className="hidden sm:inline"> · </span>
                <span className="block sm:inline">{recording.location!.name}</span>
              </>
            ) : fallbackTitle}
          </h1>
        </div>
        {(resolvedHeaderIdentity || headerActions) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
            {resolvedHeaderIdentity}
            {headerActions}
          </div>
        )}
      </div>
    </div>
  );
}

export function RecordingAudioSection({
  afterAudioPlayer,
  audioSource,
  audioUrl,
  autoPlayOnSeek,
  catalogId,
  currentTimeSetter,
  hash,
  onAudioDownload,
  onAudioEnded,
  onDurationChange,
  onPlayingChange,
  onSourceChange,
  permissions,
  recording,
  savedSourceId,
  seekRequest,
  sources,
}: RecordingAudioSectionProps) {
  const t = useTranslations();

  return (
    <div className="space-y-4 mb-6">
      {sources.length > 1 && (
        <div className="flex items-center gap-2">
          <Music className="h-4 w-4 text-muted-foreground" />
          <ResponsiveSelect value={audioSource} onValueChange={onSourceChange}>
            <ResponsiveSelectTrigger
              className="w-[180px] h-8 text-sm"
              aria-label={t("recording.source")}
            >
              <ResponsiveSelectValue
                placeholder={t("recording.source")}
                displayValue={sources.find((source) => source.id === audioSource)?.label}
              />
            </ResponsiveSelectTrigger>
            <ResponsiveSelectContent title={t("recording.source")}>
              {sources.map((source) => (
                <ResponsiveSelectItem
                  key={source.id}
                  value={source.id}
                  disabled={!source.available}
                >
                  {source.label}
                  {source.id === savedSourceId && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t("recording.saved")}
                    </span>
                  )}
                </ResponsiveSelectItem>
              ))}
            </ResponsiveSelectContent>
          </ResponsiveSelect>
        </div>
      )}

      <AudioPlayer
        src={audioUrl}
        catalogId={catalogId}
        onTimeUpdate={currentTimeSetter}
        onDurationChange={onDurationChange}
        onPlayingChange={onPlayingChange}
        onEnded={onAudioEnded}
        seekTo={seekRequest?.time}
        seekKey={seekRequest?.key}
        playbackEnd={seekRequest?.end}
        autoPlayOnSeek={autoPlayOnSeek}
      />

      {(permissions.canEditMetadata ||
        (permissions.canDownload &&
          (recording.hasArchivedAudio || recording.hasOriginalAudio))) && (
        <div className="flex flex-wrap items-center gap-2">
          {permissions.canEditMetadata && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/catalog/${catalogId}/recording/${hash}/edit`}>
                <Pencil className="h-4 w-4 mr-2" />
                {t("metadata.editCurated")}
              </Link>
            </Button>
          )}
          {permissions.canDownload && (
            <ResponsiveMenu>
              <ResponsiveMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-2" />
                  {t("recording.download")}
                </Button>
              </ResponsiveMenuTrigger>
              <ResponsiveMenuContent align="end" title={t("recording.download")}>
                {recording.hasArchivedAudio && (
                  <ResponsiveMenuItem onClick={() => onAudioDownload("archived")}>
                    {t("recording.downloadArchived")}
                  </ResponsiveMenuItem>
                )}
                {recording.hasOriginalAudio && (
                  <ResponsiveMenuItem onClick={() => onAudioDownload("original")}>
                    {t("recording.downloadOriginal")}
                  </ResponsiveMenuItem>
                )}
              </ResponsiveMenuContent>
            </ResponsiveMenu>
          )}
        </div>
      )}

      {afterAudioPlayer}
    </div>
  );
}

export function RecordingTranscriptSection({
  canDownload,
  catalogId,
  currentTime,
  hash,
  isPlaying,
  onSeek,
  onToggleTranscriptStream,
  showTranscriptStream,
}: RecordingTranscriptSectionProps) {
  const t = useTranslations();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{t("recording.transcript")}</h2>
        <div className="inline-flex items-center gap-2 rounded-full border bg-muted/40 px-3 py-1">
          <span
            className={cn(
              "text-sm transition-colors",
              showTranscriptStream ? "text-muted-foreground" : "font-medium text-foreground"
            )}
          >
            {t("recording.transcript")}
          </span>
          <Switch
            id="transcript-enabled"
            checked={showTranscriptStream}
            onCheckedChange={onToggleTranscriptStream}
            aria-label={`${t("recording.transcript")} / ${t("recording.transcriptStream")}`}
          />
          <span
            className={cn(
              "text-sm transition-colors",
              showTranscriptStream ? "font-medium text-foreground" : "text-muted-foreground"
            )}
          >
            {t("recording.transcriptStream")}
          </span>
        </div>
      </div>
      {showTranscriptStream ? (
        <TranscriptStreamViewer
          hash={hash}
          groupId={catalogId}
          currentTime={currentTime}
          onSeek={onSeek}
          isPlaying={isPlaying}
        />
      ) : (
        <TranscriptViewer
          hash={hash}
          groupId={catalogId}
          currentTime={currentTime}
          onSeek={onSeek}
          isPlaying={isPlaying}
          canDownload={canDownload}
        />
      )}
    </div>
  );
}
