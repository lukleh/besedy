"use client";

// Owns the transcript-reading workspace: loading transcript variants, virtualized
// rendering, the View menu and follow control, downloads, and reader-level
// preferences. The rendering-heavy content lives in transcript-viewer-content.tsx,
// the optional data layers in transcript-layers.ts, and the local read-model
// types in transcript-viewer-types.ts.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHydratedBoolean } from "@/hooks/use-hydrated-state";
import { useToast } from "@/hooks/use-toast";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuCheckboxItem,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  readLocalDiarization,
  readLocalDiarizationBackends,
  readLocalTranscript,
  readLocalTranscriptBackends,
  readLocalTranscriptFormats,
  withLocalFallback,
} from "@/lib/offline/local-source";
import {
  buildDiarizationBackendsUrl,
  buildDiarizationUrl,
  buildTranscriptBackendsUrl,
  buildTranscriptDownloadUrl,
  buildTranscriptFormatsUrl,
  buildTranscriptUrl,
} from "@/lib/api/recording-urls";
import { formatModelLabel } from "@/lib/transcript-labels";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  Eye,
  FileText,
  LocateFixed,
  Users,
} from "lucide-react";
import { CorrectionProgressPanel } from "@/components/correction/correction-progress-panel";
import {
  TranscriptContent,
  TranscriptSkeleton,
} from "./transcript-viewer-content";
import {
  TRANSCRIPT_LAYERS,
  useTranscriptLayers,
  type TranscriptLayerId,
} from "./transcript-layers";
import {
  FOLLOW_PREF_KEY,
  availableDiarizationsSchema,
  availableFormatsSchema,
  availableTranscriptsSchema,
  diarizationSchema,
  transcriptSchema,
  type AvailableDiarizations,
  type AvailableFormats,
  type AvailableTranscripts,
  type Diarization,
  type Transcript,
  type TranscriptBackend,
  type TranscriptFormat,
  type TranscriptViewerProps,
} from "./transcript-viewer-types";

export type {
  AvailableDiarizations,
  AvailableFormats,
  AvailableTranscripts,
  Diarization,
  Transcript,
  TranscriptBackend,
  TranscriptFormat,
  TranscriptViewerProps,
} from "./transcript-viewer-types";

export function TranscriptViewer({
  hash,
  groupId,
  clock,
  onSeek,
  canDownload = false,
  canSeeTranscriptVariants = false,
  canSeeSpeakers = false,
  canCorrectTranscripts = false,
  onTranscriptChange,
}: TranscriptViewerProps) {
  const t = useTranslations("transcript");
  const { toast } = useToast();
  const [selectedBackend, setSelectedBackend] =
    useState<TranscriptBackend | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  const [scrollToTime, setScrollToTime] = useState<number | null>(null);
  const prevBackendRef = useRef<TranscriptBackend | null>(null);
  // The stored preference is the reader's mode. Scrolling away only pauses
  // following for this visit; the jump-back button or seeking resumes it.
  const [followPref, setFollowPref] = useHydratedBoolean(FOLLOW_PREF_KEY, true);
  const [following, setFollowing] = useState(followPref);
  const [syncedFollowPref, setSyncedFollowPref] = useState(followPref);
  if (syncedFollowPref !== followPref) {
    setSyncedFollowPref(followPref);
    setFollowing(followPref);
  }
  const toggleFollowing = useCallback(() => {
    setFollowing(!following);
    setFollowPref(!following);
  }, [following, setFollowPref]);
  const handleSeek = useCallback(
    (time: number) => {
      onSeek?.(time);
      if (followPref) setFollowing(true);
    },
    [onSeek, followPref]
  );

  const [layerChoices, setLayerVisible] = useTranscriptLayers();

  const handleBackendChange = useCallback((backend: TranscriptBackend) => {
    setSelectedBackend(backend);
  }, []);

  // Every transcript request goes to the network first and falls back to the
  // transcript stored with a completed download of this recording.
  const { data: available, isLoading: loadingBackends } =
    useQuery<AvailableTranscripts>({
      queryKey: ["transcript-backends", hash, groupId],
      networkMode: "offlineFirst",
      queryFn: async () =>
        withLocalFallback(
          () =>
            fetchJson<AvailableTranscripts>(
              buildTranscriptBackendsUrl(groupId, hash),
              {
                schema: availableTranscriptsSchema,
              }
            ),
          () => readLocalTranscriptBackends(groupId, hash)
        ),
    });

  const effectiveBackend = selectedBackend || available?.backends[0] || null;

  useEffect(() => {
    if (
      prevBackendRef.current !== null &&
      prevBackendRef.current !== effectiveBackend &&
      effectiveBackend !== null &&
      clock &&
      clock.get() > 0
    ) {
      setScrollToTime(clock.get());
    }
    prevBackendRef.current = effectiveBackend;
  }, [effectiveBackend, clock]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const { data: availableFormats } = useQuery<AvailableFormats>({
    queryKey: ["transcript-formats", hash, groupId, effectiveBackend],
    networkMode: "offlineFirst",
    queryFn: async () =>
      withLocalFallback(
        () =>
          fetchJson<AvailableFormats>(
            buildTranscriptFormatsUrl(groupId, hash, effectiveBackend ?? ""),
            {
              schema: availableFormatsSchema,
            }
          ),
        () => readLocalTranscriptFormats(groupId, hash, effectiveBackend ?? "")
      ),
    enabled: !!effectiveBackend,
  });

  const handleTranscriptDownload = useCallback(
    (format: TranscriptFormat) => {
      if (!effectiveBackend) return;
      window.open(buildTranscriptDownloadUrl(groupId, hash, effectiveBackend, format), "_blank");
    },
    [hash, effectiveBackend, groupId]
  );

  const { data: transcript, isLoading: loadingTranscript } =
    useQuery<Transcript>({
      queryKey: ["transcript", hash, groupId, effectiveBackend],
      networkMode: "offlineFirst",
      queryFn: async () =>
        withLocalFallback(
          () =>
            fetchJson<Transcript>(
              buildTranscriptUrl(groupId, hash, effectiveBackend ?? ""),
              {
                schema: transcriptSchema,
              }
            ),
          () => readLocalTranscript(groupId, hash)
        ),
      enabled: !!effectiveBackend,
    });

  useEffect(() => {
    onTranscriptChange?.(transcript ?? null);
  }, [transcript, onTranscriptChange]);

  const transcriptPlainText = useMemo(() => {
    if (!transcript?.segments?.length) return "";
    const text = transcript.segments
      .map((segment) => segment.text?.trim())
      .filter(Boolean)
      .join("\n");
    return text ? `${text}\n` : "";
  }, [transcript]);

  const handleTranscriptCopy = useCallback(async () => {
    if (!transcriptPlainText) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(transcriptPlainText);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = transcriptPlainText;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.top = "-9999px";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!success) {
          throw new Error("Copy failed");
        }
      }
      setCopySuccess(true);
      if (copyResetRef.current) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(() => {
        setCopySuccess(false);
      }, 2000);
    } catch {
      setCopySuccess(false);
      toast({ title: t("copyError"), variant: "destructive" });
    }
  }, [transcriptPlainText, toast, t]);

  const { data: availableDiarizations } = useQuery<AvailableDiarizations>({
    queryKey: ["diarization-backends", hash, groupId],
    networkMode: "offlineFirst",
    queryFn: async () => {
      try {
        return await withLocalFallback(
          () =>
            fetchJson<AvailableDiarizations>(
              buildDiarizationBackendsUrl(groupId, hash),
              {
                schema: availableDiarizationsSchema,
              }
            ),
          () => readLocalDiarizationBackends(groupId, hash)
        );
      } catch {
        return { hash, backends: [] };
      }
    },
  });

  // The overlay is administrative, so a stored preference from when it was
  // shown to everyone does not bring it back.
  const hasDiarization =
    canSeeSpeakers && (availableDiarizations?.backends.length ?? 0) > 0;
  const layerAvailable: Record<TranscriptLayerId, boolean> = {
    timestamps: true,
    speakers: hasDiarization,
  };
  const availableLayers = TRANSCRIPT_LAYERS.filter(
    (layer) => layerAvailable[layer.id]
  );
  const layerVisible = (id: TranscriptLayerId) =>
    layerAvailable[id] && layerChoices[id];
  const visibleLayerCount = availableLayers.filter((layer) =>
    layerVisible(layer.id)
  ).length;
  const speakersVisible = layerVisible("speakers");

  const effectiveDiarizationBackend = availableDiarizations?.backends.includes(
    "pyannote"
  )
    ? "pyannote"
    : availableDiarizations?.backends[0] || null;

  const { data: diarization } = useQuery<Diarization>({
    queryKey: ["diarization", hash, groupId, effectiveDiarizationBackend],
    networkMode: "offlineFirst",
    queryFn: async () =>
      withLocalFallback(
        () =>
          fetchJson<Diarization>(
            buildDiarizationUrl(groupId, hash, effectiveDiarizationBackend ?? ""),
            {
              schema: diarizationSchema,
            }
          ),
        () => readLocalDiarization(groupId, hash)
      ),
    enabled: !!effectiveDiarizationBackend && speakersVisible,
  });

  if (loadingBackends) {
    return <TranscriptSkeleton />;
  }

  // A correction-eligible primary transcript that has never been published has
  // no text to show. That is the product decision, not a missing file, so the
  // reader gets progress rather than the "not transcribed" empty state.
  //
  // Only when there is nothing to read, though: an actor holding
  // see_transcript_variants is sent the machine backends as well, and ADR 0006
  // keeps those open to them before publication.
  if (available?.correction && available.backends.length === 0) {
    return (
      <CorrectionProgressPanel
        state={available.correction}
        catalogId={groupId}
        hash={hash}
        canCorrect={canCorrectTranscripts}
      />
    );
  }

  if (!available || available.backends.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center rounded-lg border bg-muted/50">
        <FileText className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="font-medium">{t("noTranscripts")}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {t("noTranscriptsDescription")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {canSeeTranscriptVariants && (
          <>
            <span className="text-sm font-medium">{t("source")}:</span>
            <ResponsiveMenu>
              <ResponsiveMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  title={effectiveBackend ?? undefined}
                >
                  {effectiveBackend
                    ? formatModelLabel(effectiveBackend)
                    : "..."}
                  <ChevronDown className="h-4 w-4 opacity-50" />
                </Button>
              </ResponsiveMenuTrigger>
              <ResponsiveMenuContent title={t("source")}>
                {available.backends.map((backend) => (
                  <ResponsiveMenuItem
                    key={backend}
                    onClick={() => handleBackendChange(backend)}
                    title={backend}
                  >
                    {formatModelLabel(backend)}
                  </ResponsiveMenuItem>
                ))}
              </ResponsiveMenuContent>
            </ResponsiveMenu>
          </>
        )}
        <Button
          variant="outline"
          size="icon"
          aria-label={copySuccess ? t("copySuccess") : t("copy")}
          title={copySuccess ? t("copySuccess") : t("copy")}
          className={
            copySuccess
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
              : undefined
          }
          onClick={handleTranscriptCopy}
          disabled={!transcriptPlainText || loadingTranscript}
        >
          {copySuccess ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
        {canDownload &&
          effectiveBackend &&
          availableFormats?.formats?.length && (
            <ResponsiveMenu>
              <ResponsiveMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Download className="h-4 w-4" />
                  {t("download")}
                </Button>
              </ResponsiveMenuTrigger>
              <ResponsiveMenuContent title={t("download")}>
                {availableFormats.formats.includes("json") && (
                  <ResponsiveMenuItem
                    onClick={() => handleTranscriptDownload("json")}
                  >
                    JSON
                  </ResponsiveMenuItem>
                )}
                {availableFormats.formats.includes("txt") && (
                  <ResponsiveMenuItem
                    onClick={() => handleTranscriptDownload("txt")}
                  >
                    {t("plainText")}
                  </ResponsiveMenuItem>
                )}
                {availableFormats.formats.includes("srt") && (
                  <ResponsiveMenuItem
                    onClick={() => handleTranscriptDownload("srt")}
                  >
                    SRT
                  </ResponsiveMenuItem>
                )}
                {availableFormats.formats.includes("vtt") && (
                  <ResponsiveMenuItem
                    onClick={() => handleTranscriptDownload("vtt")}
                  >
                    VTT
                  </ResponsiveMenuItem>
                )}
              </ResponsiveMenuContent>
            </ResponsiveMenu>
          )}
        {canSeeTranscriptVariants && available.backends.length > 1 && (
          <Badge variant="secondary" className="sm:hidden">
            {t("sourcesPlural", { count: available.backends.length })}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <ResponsiveMenu>
            <ResponsiveMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Eye className="h-4 w-4" />
                {t("view")}
                {visibleLayerCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="h-5 min-w-5 rounded-full px-1.5 tabular-nums"
                  >
                    {visibleLayerCount}
                  </Badge>
                )}
                <ChevronDown className="h-4 w-4 opacity-50" />
              </Button>
            </ResponsiveMenuTrigger>
            <ResponsiveMenuContent title={t("view")} showCloseButton={false}>
              {availableLayers.map((layer) => {
                const Icon = layer.icon;
                return (
                  <ResponsiveMenuCheckboxItem
                    key={layer.id}
                    checked={layerChoices[layer.id]}
                    onCheckedChange={(checked) =>
                      setLayerVisible(layer.id, checked)
                    }
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {t(layer.labelKey)}
                  </ResponsiveMenuCheckboxItem>
                );
              })}
            </ResponsiveMenuContent>
          </ResponsiveMenu>
          <Button
            variant={following ? "secondary" : "outline"}
            size="sm"
            className="gap-2"
            aria-pressed={following}
            title={following ? t("followingHint") : t("followHint")}
            onClick={toggleFollowing}
          >
            <LocateFixed
              className={following ? "h-4 w-4 text-primary" : "h-4 w-4"}
            />
            {t("follow")}
          </Button>
          {canSeeTranscriptVariants && available.backends.length > 0 && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {available.backends.length === 1
                ? t("sources", { count: 1 })
                : t("sourcesPlural", { count: available.backends.length })}
            </Badge>
          )}
        </div>
      </div>

      {speakersVisible && diarization && diarization.numSpeakers > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Users className="h-3 w-3" />
          <span>
            {diarization.numSpeakers === 1
              ? t("speakersDetected", { count: 1 })
              : t("speakersDetectedPlural", { count: diarization.numSpeakers })}
          </span>
        </div>
      )}

      {loadingTranscript ? (
        <TranscriptSkeleton />
      ) : transcript ? (
        <TranscriptContent
          transcript={transcript}
          clock={clock}
          onSeek={handleSeek}
          follow={following}
          onFollowChange={setFollowing}
          diarization={speakersVisible ? diarization : undefined}
          showTimestamps={layerVisible("timestamps")}
          scrollToTime={scrollToTime}
          onScrollComplete={() => setScrollToTime(null)}
        />
      ) : null}
    </div>
  );
}
