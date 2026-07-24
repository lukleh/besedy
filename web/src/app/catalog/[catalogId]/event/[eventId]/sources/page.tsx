"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, File, FileAudio, FileImage, FileText, FileVideo, Globe, Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { fetchJson } from "@/lib/api/fetch-json";
import type { RecordingSource, RecordingSourceType } from "@/types/recording-sources";

interface EventSourcesPageProps {
  params: Promise<{ catalogId: string; eventId: string }>;
}

interface EventDetailResponse {
  id: number;
  title: string | null;
  canManageSources?: boolean;
}

interface SourcesResponse {
  eventId: number;
  sources: RecordingSource[];
}

function formatBytes(bytes?: number | null): string | null {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function getFileIcon(mimeType?: string | null, filename?: string) {
  const mime = mimeType?.toLowerCase() ?? "";
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";

  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(ext)) {
    return FileAudio;
  }
  if (mime.startsWith("video/") || ["mp4", "webm", "mkv", "avi", "mov"].includes(ext)) {
    return FileVideo;
  }
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) {
    return FileImage;
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return FileText;
  }
  return File;
}

export default function EventSourcesPage({ params }: EventSourcesPageProps) {
  const { catalogId, eventId } = use(params);
  const parsedEventId = Number.parseInt(eventId, 10);
  const t = useTranslations();
  const tCommon = useTranslations("common");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [sourceType, setSourceType] = useState<RecordingSourceType>("url");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const { data: eventData, isLoading: eventLoading, error: eventError } = useQuery<EventDetailResponse>({
    queryKey: ["catalog-event-detail", parsedEventId],
    queryFn: () => fetchJson(`/api/catalogs/${catalogId}/events/${parsedEventId}`),
  });

  const canManageSources = eventData?.canManageSources ?? false;

  const { data: sourcesData, isLoading: sourcesLoading, error: sourcesError } = useQuery<SourcesResponse>({
    queryKey: ["event-sources", parsedEventId],
    queryFn: () => fetchJson(`/api/catalogs/${catalogId}/events/${parsedEventId}/sources`),
    enabled: !!eventData && canManageSources,
  });

  const addSourceMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      formData.append("type", sourceType);
      if (sourceType === "url") {
        formData.append("title", title);
        formData.append("url", url);
      } else if (file) {
        formData.append("file", file);
      }
      return fetchJson(`/api/catalogs/${catalogId}/events/${parsedEventId}/sources`, {
        method: "POST",
        body: formData,
      });
    },
    onSuccess: () => {
      toast({ title: t("recording.sourcesAddSuccess") });
      setTitle("");
      setUrl("");
      setFile(null);
      queryClient.invalidateQueries({ queryKey: ["event-sources", parsedEventId] });
    },
    onError: (err: Error) => {
      toast({
        title: t("recording.sourcesAddError"),
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const deleteSourceMutation = useMutation({
    mutationFn: async (sourceId: string) => {
      return fetchJson(
        `/api/catalogs/${catalogId}/events/${parsedEventId}/sources/${sourceId}`,
        { method: "DELETE" }
      );
    },
    onSuccess: () => {
      toast({ title: t("recording.sourcesDeleteSuccess") });
      queryClient.invalidateQueries({ queryKey: ["event-sources", parsedEventId] });
    },
    onError: (err: Error) => {
      toast({
        title: t("recording.sourcesDeleteError"),
        description: err.message,
        variant: "destructive",
      });
    },
  });

  if (!Number.isFinite(parsedEventId) || parsedEventId <= 0) {
    return (
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <p className="text-sm text-destructive">{t("events.detail.unknownError")}</p>
      </div>
    );
  }

  if (eventLoading) {
    return (
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (eventError || !eventData) {
    return (
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <p className="text-sm text-destructive">
          {eventError instanceof Error ? eventError.message : t("events.detail.unknownError")}
        </p>
      </div>
    );
  }

  if (!canManageSources) {
    router.replace(`/catalog/${catalogId}/event/${parsedEventId}`);
    return null;
  }

  const sources = sourcesData?.sources ?? [];
  const isBusy = addSourceMutation.isPending || deleteSourceMutation.isPending;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div className="space-y-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/catalog/${catalogId}/event/${parsedEventId}`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("recording.backToEvent")}
          </Link>
        </Button>
        <h1 className="text-xl sm:text-2xl font-semibold">{t("recording.sourcesTitle")}</h1>
        <p className="text-sm text-muted-foreground">
          {eventData.title ?? t("events.editor.eventFallbackTitle", { id: eventData.id })}
        </p>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex gap-2">
          <Button
            variant={sourceType === "url" ? "default" : "outline"}
            type="button"
            size="sm"
            onClick={() => setSourceType("url")}
            disabled={isBusy}
          >
            {t("recording.sourcesTypeUrl")}
          </Button>
          <Button
            variant={sourceType === "file" ? "default" : "outline"}
            type="button"
            size="sm"
            onClick={() => setSourceType("file")}
            disabled={isBusy}
          >
            {t("recording.sourcesTypeFile")}
          </Button>
        </div>

        {sourceType === "url" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="event-source-title">{t("recording.sourcesTitleLabel")}</Label>
              <Input
                id="event-source-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-source-url">{t("recording.sourcesUrlLabel")}</Label>
              <Input
                id="event-source-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://..."
              />
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="event-source-file">{t("recording.sourcesFileLabel")}</Label>
            <Input
              id="event-source-file"
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
        )}

        <Button onClick={() => addSourceMutation.mutate()} disabled={isBusy}>
          {addSourceMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {t("recording.sourcesAdd")}
        </Button>
      </div>

      <div className="rounded-lg border">
        {sourcesLoading ? (
          <div className="p-4 text-sm text-muted-foreground">{tCommon("loading")}</div>
        ) : sourcesError ? (
          <div className="p-4 text-sm text-destructive">
            {sourcesError instanceof Error ? sourcesError.message : t("recording.sourcesLoadError")}
          </div>
        ) : sources.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{t("recording.sourcesEmpty")}</div>
        ) : (
          <div className="divide-y">
            {sources.map((source) => (
              <div key={source.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  {source.type === "url" ? (
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <a
                        href={`/api/catalogs/${catalogId}/events/${parsedEventId}/sources/${source.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-sm underline-offset-2 hover:underline"
                      >
                        {source.title || source.url}
                      </a>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {(() => {
                        const Icon = getFileIcon(source.mimeType, source.originalName);
                        return <Icon className="h-4 w-4 text-muted-foreground" />;
                      })()}
                      <a
                        href={`/api/catalogs/${catalogId}/events/${parsedEventId}/sources/${source.id}`}
                        className="truncate text-sm underline-offset-2 hover:underline"
                      >
                        {source.originalName}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {formatBytes(source.size)}
                      </span>
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => deleteSourceMutation.mutate(source.id)}
                  disabled={isBusy}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  {tCommon("delete")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
