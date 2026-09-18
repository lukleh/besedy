"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import NextImage from "next/image";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { fetchJson } from "@/lib/api/fetch-json";

interface EventPosterPageProps {
  params: Promise<{ catalogId: string; eventId: string }>;
}

interface EventDetailResponse {
  id: number;
  title: string | null;
  location: { id: number; name: string } | null;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  canManagePosters?: boolean;
  posterStatus?: {
    portrait: boolean;
    landscape: boolean;
  } | null;
  posterFiles?: {
    portrait: { exists: boolean; filename: string | null; uploadedAt?: string | null };
    landscape: { exists: boolean; filename: string | null; uploadedAt?: string | null };
  } | null;
}

export default function EventPosterPage({ params }: EventPosterPageProps) {
  const { catalogId, eventId } = use(params);
  const parsedEventId = Number.parseInt(eventId, 10);
  const t = useTranslations();
  const router = useRouter();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [portraitFile, setPortraitFile] = useState<File | null>(null);
  const [landscapeFile, setLandscapeFile] = useState<File | null>(null);

  const portraitPreviewUrl = useMemo(
    () => (portraitFile ? URL.createObjectURL(portraitFile) : null),
    [portraitFile]
  );
  const landscapePreviewUrl = useMemo(
    () => (landscapeFile ? URL.createObjectURL(landscapeFile) : null),
    [landscapeFile]
  );

  useEffect(() => {
    return () => {
      if (portraitPreviewUrl) URL.revokeObjectURL(portraitPreviewUrl);
    };
  }, [portraitPreviewUrl]);

  useEffect(() => {
    return () => {
      if (landscapePreviewUrl) URL.revokeObjectURL(landscapePreviewUrl);
    };
  }, [landscapePreviewUrl]);

  const { data, isLoading, error } = useQuery<EventDetailResponse>({
    queryKey: ["catalog-event-detail", parsedEventId],
    queryFn: () => fetchJson(`/api/catalogs/${catalogId}/events/${parsedEventId}`),
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!portraitFile && !landscapeFile) {
        throw new Error(t("recording.posterFilesRequired"));
      }

      const formData = new FormData();
      if (portraitFile) formData.append("portrait", portraitFile);
      if (landscapeFile) formData.append("landscape", landscapeFile);

      return fetchJson(`/api/catalogs/${catalogId}/events/${parsedEventId}/poster`, {
        method: "POST",
        body: formData,
      });
    },
    onSuccess: () => {
      toast({ title: t("recording.posterUploadSuccess") });
      setPortraitFile(null);
      setLandscapeFile(null);
      queryClient.invalidateQueries({ queryKey: ["catalog-event-detail", parsedEventId] });
    },
    onError: (err: Error) => {
      toast({
        title: t("recording.posterUploadError"),
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (variant: "portrait" | "landscape") => {
      return fetchJson(
        `/api/catalogs/${catalogId}/events/${parsedEventId}/poster?variant=${variant}`,
        { method: "DELETE" }
      );
    },
    onSuccess: () => {
      toast({ title: t("recording.posterDeleteSuccess") });
      queryClient.invalidateQueries({ queryKey: ["catalog-event-detail", parsedEventId] });
    },
    onError: (err: Error) => {
      toast({
        title: t("recording.posterDeleteError"),
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

  if (isLoading) {
    return (
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : t("events.detail.unknownError")}
        </p>
      </div>
    );
  }

  const canManagePosters = data.canManagePosters ?? false;
  if (!canManagePosters) {
    router.replace(`/catalog/${catalogId}/event/${parsedEventId}`);
    return null;
  }

  const posterStatus = data.posterStatus;
  const posterFiles = data.posterFiles;
  const portraitExisting = posterFiles?.portrait.exists ?? posterStatus?.portrait ?? false;
  const landscapeExisting = posterFiles?.landscape.exists ?? posterStatus?.landscape ?? false;

  const portraitVersion = posterFiles?.portrait.uploadedAt;
  const landscapeVersion = posterFiles?.landscape.uploadedAt;
  const portraitSrc = `/api/catalogs/${catalogId}/events/${parsedEventId}/poster?variant=portrait${portraitVersion ? `&v=${encodeURIComponent(portraitVersion)}` : ""}`;
  const landscapeSrc = `/api/catalogs/${catalogId}/events/${parsedEventId}/poster?variant=landscape${landscapeVersion ? `&v=${encodeURIComponent(landscapeVersion)}` : ""}`;

  const isBusy = uploadMutation.isPending || deleteMutation.isPending;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div className="space-y-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/catalog/${catalogId}/event/${parsedEventId}`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("recording.backToEvent")}
          </Link>
        </Button>
        <h1 className="text-xl sm:text-2xl font-semibold">{t("recording.editPoster")}</h1>
        <p className="text-sm text-muted-foreground">
          {data.title ?? t("events.editor.eventFallbackTitle", { id: data.id })}
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-sm font-medium">{t("recording.posterPortrait")}</h2>
          {portraitPreviewUrl ? (
            <NextImage
              src={portraitPreviewUrl}
              alt={t("recording.posterPortrait")}
              width={900}
              height={1600}
              className="w-full rounded-lg border bg-muted object-contain"
              unoptimized
            />
          ) : portraitExisting ? (
            <NextImage
              src={portraitSrc}
              alt={t("recording.posterPortrait")}
              width={900}
              height={1600}
              className="w-full rounded-lg border bg-muted object-contain"
              unoptimized
            />
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
              {t("recording.posterMissing")}
            </div>
          )}
          <input
            type="file"
            accept=".jpg,.jpeg,.png"
            onChange={(event) => setPortraitFile(event.target.files?.[0] ?? null)}
            disabled={isBusy}
          />
          {portraitExisting && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => deleteMutation.mutate("portrait")}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {t("recording.posterDelete")}
            </Button>
          )}
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-medium">{t("recording.posterLandscape")}</h2>
          {landscapePreviewUrl ? (
            <NextImage
              src={landscapePreviewUrl}
              alt={t("recording.posterLandscape")}
              width={1600}
              height={900}
              className="w-full rounded-lg border bg-muted object-contain"
              unoptimized
            />
          ) : landscapeExisting ? (
            <NextImage
              src={landscapeSrc}
              alt={t("recording.posterLandscape")}
              width={1600}
              height={900}
              className="w-full rounded-lg border bg-muted object-contain"
              unoptimized
            />
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
              {t("recording.posterMissing")}
            </div>
          )}
          <input
            type="file"
            accept=".jpg,.jpeg,.png"
            onChange={(event) => setLandscapeFile(event.target.files?.[0] ?? null)}
            disabled={isBusy}
          />
          {landscapeExisting && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => deleteMutation.mutate("landscape")}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {t("recording.posterDelete")}
            </Button>
          )}
        </div>
      </div>

      <Button onClick={() => uploadMutation.mutate()} disabled={isBusy}>
        {uploadMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        {t("recording.posterUpload")}
      </Button>
    </div>
  );
}
