"use client";

// Owns the transcript-reading workspace: loading transcript variants, virtualized
// rendering, speaker/download controls, and reader-level preferences. The
// rendering-heavy content lives in transcript-viewer-content.tsx and the local
// read-model types live in transcript-viewer-types.ts.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHydratedBoolean } from "@/hooks/use-hydrated-state";
import { useToast } from "@/hooks/use-toast";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";
import { Switch } from "@/components/ui/switch";
import { fetchJson } from "@/lib/api/fetch-json";
import { formatModelLabel } from "@/lib/transcript-labels";
import { Check, ChevronDown, Clock, Copy, Download, FileText, Users } from "lucide-react";
import { TranscriptContent, TranscriptSkeleton } from "./transcript-viewer-content";
import {
  AUTO_SCROLL_PREF_KEY,
  SPEAKER_LABELS_PREF_KEY,
  TIMESTAMPS_PREF_KEY,
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
  currentTime = 0,
  onSeek,
  isPlaying = false,
  canDownload = false,
}: TranscriptViewerProps) {
  const t = useTranslations("transcript");
  const { toast } = useToast();
  const groupKey = groupId || "default";
  const [selectedBackend, setSelectedBackend] = useState<TranscriptBackend | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  const [scrollToTime, setScrollToTime] = useState<number | null>(null);
  const prevBackendRef = useRef<TranscriptBackend | null>(null);
  const [autoScroll, setAutoScroll] = useHydratedBoolean(AUTO_SCROLL_PREF_KEY, true);
  const [showSpeakers, setShowSpeakers] = useHydratedBoolean(SPEAKER_LABELS_PREF_KEY, true);
  const [showTimestamps, setShowTimestamps] = useHydratedBoolean(TIMESTAMPS_PREF_KEY, true);

  const handleBackendChange = useCallback((backend: TranscriptBackend) => {
    setSelectedBackend(backend);
  }, []);

  const { data: available, isLoading: loadingBackends } = useQuery<AvailableTranscripts>({
    queryKey: ["transcript-backends", hash, groupKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (groupId) {
        params.set("group", groupId);
      }
      const suffix = params.toString();
      return fetchJson<AvailableTranscripts>(
        `/api/transcript/${hash}${suffix ? `?${suffix}` : ""}`,
        {
          schema: availableTranscriptsSchema,
        }
      );
    },
  });

  const effectiveBackend = selectedBackend || available?.backends[0] || null;

  useEffect(() => {
    if (
      prevBackendRef.current !== null &&
      prevBackendRef.current !== effectiveBackend &&
      effectiveBackend !== null &&
      currentTime > 0
    ) {
      setScrollToTime(currentTime);
    }
    prevBackendRef.current = effectiveBackend;
  }, [effectiveBackend, currentTime]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const { data: availableFormats } = useQuery<AvailableFormats>({
    queryKey: ["transcript-formats", hash, groupKey, effectiveBackend],
    queryFn: async () => {
      const params = new URLSearchParams({
        backend: effectiveBackend ?? "",
      });
      if (groupId) {
        params.set("group", groupId);
      }
      return fetchJson<AvailableFormats>(
        `/api/transcript/${hash}/formats?${params.toString()}`,
        {
          schema: availableFormatsSchema,
        }
      );
    },
    enabled: !!effectiveBackend,
  });

  const handleTranscriptDownload = useCallback(
    (format: TranscriptFormat) => {
      if (!effectiveBackend) return;
      const params = new URLSearchParams({
        backend: effectiveBackend,
        format,
      });
      if (groupId) {
        params.set("group", groupId);
      }
      window.open(`/api/transcript/${hash}/download?${params.toString()}`, "_blank");
    },
    [hash, effectiveBackend, groupId],
  );

  const { data: transcript, isLoading: loadingTranscript } = useQuery<Transcript>({
    queryKey: ["transcript", hash, groupKey, effectiveBackend],
    queryFn: async () => {
      const params = new URLSearchParams({
        backend: effectiveBackend ?? "",
      });
      if (groupId) {
        params.set("group", groupId);
      }
      return fetchJson<Transcript>(`/api/transcript/${hash}?${params.toString()}`, {
        schema: transcriptSchema,
      });
    },
    enabled: !!effectiveBackend,
  });

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
    queryKey: ["diarization-backends", hash, groupKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (groupId) {
        params.set("group", groupId);
      }
      const suffix = params.toString();
      try {
        return await fetchJson<AvailableDiarizations>(
          `/api/transcript/${hash}/speakers${suffix ? `?${suffix}` : ""}`,
          {
            schema: availableDiarizationsSchema,
          }
        );
      } catch {
        return { hash, backends: [] };
      }
    },
  });

  const effectiveDiarizationBackend =
    availableDiarizations?.backends.includes("pyannote")
      ? "pyannote"
      : availableDiarizations?.backends[0] || null;

  const { data: diarization } = useQuery<Diarization>({
    queryKey: ["diarization", hash, groupKey, effectiveDiarizationBackend],
    queryFn: async () => {
      const params = new URLSearchParams({
        backend: effectiveDiarizationBackend ?? "",
      });
      if (groupId) {
        params.set("group", groupId);
      }
      return fetchJson<Diarization>(
        `/api/transcript/${hash}/speakers?${params.toString()}`,
        {
          schema: diarizationSchema,
        }
      );
    },
    enabled: !!effectiveDiarizationBackend && showSpeakers,
  });

  const hasDiarization = (availableDiarizations?.backends.length ?? 0) > 0;

  if (loadingBackends) {
    return <TranscriptSkeleton />;
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
        <span className="text-sm font-medium">{t("source")}:</span>
        <ResponsiveMenu>
          <ResponsiveMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              title={effectiveBackend ?? undefined}
            >
              {effectiveBackend ? formatModelLabel(effectiveBackend) : "..."}
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
          {copySuccess ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
        {canDownload && effectiveBackend && availableFormats?.formats?.length && (
          <ResponsiveMenu>
            <ResponsiveMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Download className="h-4 w-4" />
                {t("download")}
              </Button>
            </ResponsiveMenuTrigger>
            <ResponsiveMenuContent title={t("download")}>
              {availableFormats.formats.includes("json") && (
                <ResponsiveMenuItem onClick={() => handleTranscriptDownload("json")}>
                  JSON
                </ResponsiveMenuItem>
              )}
              {availableFormats.formats.includes("txt") && (
                <ResponsiveMenuItem onClick={() => handleTranscriptDownload("txt")}>
                  {t("plainText")}
                </ResponsiveMenuItem>
              )}
              {availableFormats.formats.includes("srt") && (
                <ResponsiveMenuItem onClick={() => handleTranscriptDownload("srt")}>
                  SRT
                </ResponsiveMenuItem>
              )}
              {availableFormats.formats.includes("vtt") && (
                <ResponsiveMenuItem onClick={() => handleTranscriptDownload("vtt")}>
                  VTT
                </ResponsiveMenuItem>
              )}
            </ResponsiveMenuContent>
          </ResponsiveMenu>
        )}
        {available.backends.length > 1 && (
          <Badge variant="secondary" className="sm:hidden">
            {t("sourcesPlural", { count: available.backends.length })}
          </Badge>
        )}
        <div className="w-full sm:w-auto sm:ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 mt-2 sm:mt-0">
          {hasDiarization && (
            <div className="flex items-center gap-2">
              <Switch
                id="show-speakers"
                checked={showSpeakers}
                onCheckedChange={setShowSpeakers}
              />
              <Label htmlFor="show-speakers" className="text-sm cursor-pointer flex items-center gap-1">
                <Users className="h-3 w-3" />
                {t("speakers")}
              </Label>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch
              id="show-timestamps"
              checked={showTimestamps}
              onCheckedChange={setShowTimestamps}
            />
            <Label htmlFor="show-timestamps" className="text-sm cursor-pointer flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {t("timestamps")}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="auto-scroll"
              checked={autoScroll}
              onCheckedChange={setAutoScroll}
            />
            <Label htmlFor="auto-scroll" className="text-sm cursor-pointer">
              {t("autoScroll")}
            </Label>
          </div>
          {available.backends.length > 0 && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {available.backends.length === 1
                ? t("sources", { count: 1 })
                : t("sourcesPlural", { count: available.backends.length })}
            </Badge>
          )}
        </div>
      </div>

      {showSpeakers && diarization && diarization.numSpeakers > 0 && (
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
          currentTime={currentTime}
          onSeek={onSeek}
          autoScroll={autoScroll && isPlaying}
          diarization={showSpeakers ? diarization : undefined}
          showTimestamps={showTimestamps}
          scrollToTime={scrollToTime}
          onScrollComplete={() => setScrollToTime(null)}
        />
      ) : null}
    </div>
  );
}
