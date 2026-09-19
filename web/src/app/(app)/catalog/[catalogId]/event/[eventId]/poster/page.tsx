"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Send, Trash2, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  buildEventDetailUrl,
  buildEventPosterCandidateUrl,
  buildEventPosterCandidateImageUrl,
  buildEventPosterCandidatesUrl,
  buildEventPosterPublicationUrl,
} from "@/lib/api/recording-urls";

interface EventPosterPageProps {
  params: Promise<{ catalogId: string; eventId: string }>;
}

interface EventDetailResponse {
  id: number;
  title: string | null;
  canViewPosterCandidates?: boolean;
  canManagePosters?: boolean;
  canPublishPosters?: boolean;
}

interface PosterCandidate {
  id: string;
  eventId: number;
  label: string | null;
  createdAt: string;
  createdBy: { id: string; name: string | null; email: string | null };
  published: boolean;
  publishedAt: string | null;
  assets: {
    square: { originalName: string; bytes: number; sha256: string };
    landscape: { originalName: string; bytes: number; sha256: string };
  };
}

interface CandidatesResponse {
  candidates: PosterCandidate[];
}

export default function EventPosterPage({ params }: EventPosterPageProps) {
  const { catalogId, eventId } = use(params);
  const parsedEventId = Number.parseInt(eventId, 10);
  const t = useTranslations("events.poster");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [squareFile, setSquareFile] = useState<File | null>(null);
  const [landscapeFile, setLandscapeFile] = useState<File | null>(null);
  const [confirmation, setConfirmation] = useState<{
    action: "delete" | "unpublish";
    candidate: PosterCandidate;
  } | null>(null);

  const squarePreview = useMemo(() => (squareFile ? URL.createObjectURL(squareFile) : null), [squareFile]);
  const landscapePreview = useMemo(() => (landscapeFile ? URL.createObjectURL(landscapeFile) : null), [landscapeFile]);
  useEffect(
    () => () => {
      if (squarePreview) URL.revokeObjectURL(squarePreview);
    },
    [squarePreview]
  );
  useEffect(
    () => () => {
      if (landscapePreview) URL.revokeObjectURL(landscapePreview);
    },
    [landscapePreview]
  );

  const detailQuery = useQuery<EventDetailResponse>({
    queryKey: ["catalog-event-detail", parsedEventId],
    queryFn: () => fetchJson(buildEventDetailUrl(catalogId, parsedEventId)),
    enabled: Number.isSafeInteger(parsedEventId) && parsedEventId > 0,
  });
  const canManage = detailQuery.data?.canManagePosters ?? false;
  const canPublish = detailQuery.data?.canPublishPosters ?? false;
  const canView = detailQuery.data?.canViewPosterCandidates ?? false;
  const candidatesQuery = useQuery<CandidatesResponse>({
    queryKey: ["event-poster-candidates", catalogId, parsedEventId],
    queryFn: () => fetchJson(buildEventPosterCandidatesUrl(catalogId, parsedEventId)),
    enabled: canView,
  });
  useEffect(() => {
    if (detailQuery.data && !canView) {
      router.replace(`/catalog/${catalogId}/event/${parsedEventId}`);
    }
  }, [canView, catalogId, detailQuery.data, parsedEventId, router]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["event-poster-candidates", catalogId, parsedEventId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["catalog-event-detail", parsedEventId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["catalog-events", catalogId],
      }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!squareFile || !landscapeFile) throw new Error(t("bothRequired"));
      const form = new FormData();
      form.append("square", squareFile);
      form.append("landscape", landscapeFile);
      if (label.trim()) form.append("label", label.trim());
      return fetchJson(buildEventPosterCandidatesUrl(catalogId, parsedEventId), {
        method: "POST",
        body: form,
      });
    },
    onSuccess: async () => {
      setSquareFile(null);
      setLandscapeFile(null);
      setLabel("");
      await refresh();
      toast({ title: t("created") });
    },
    onError: (error: Error) =>
      toast({
        title: t("createFailed"),
        description: error.message,
        variant: "destructive",
      }),
  });

  const publishMutation = useMutation({
    mutationFn: (posterId: string) =>
      fetchJson(buildEventPosterPublicationUrl(catalogId, parsedEventId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posterId }),
      }),
    onSuccess: async () => {
      await refresh();
      toast({ title: t("published") });
    },
    onError: (error: Error) =>
      toast({
        title: t("publishFailed"),
        description: error.message,
        variant: "destructive",
      }),
  });

  const unpublishMutation = useMutation({
    mutationFn: () =>
      fetchJson(buildEventPosterPublicationUrl(catalogId, parsedEventId), {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await refresh();
      toast({ title: t("unpublished") });
    },
    onError: (error: Error) =>
      toast({
        title: t("unpublishFailed"),
        description: error.message,
        variant: "destructive",
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (posterId: string) =>
      fetchJson(buildEventPosterCandidateUrl(catalogId, parsedEventId, posterId), {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await refresh();
      toast({ title: t("deleted") });
    },
    onError: (error: Error) =>
      toast({
        title: t("deleteFailed"),
        description: error.message,
        variant: "destructive",
      }),
  });

  if (!Number.isSafeInteger(parsedEventId) || parsedEventId <= 0) {
    return <div className="p-6 text-sm text-destructive">{t("invalidEvent")}</div>;
  }
  if (detailQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (detailQuery.error || !detailQuery.data) {
    return <div className="p-6 text-sm text-destructive">{t("loadFailed")}</div>;
  }
  if (!canView) {
    return null;
  }

  const isBusy =
    createMutation.isPending || publishMutation.isPending || unpublishMutation.isPending || deleteMutation.isPending;
  const candidates = candidatesQuery.data?.candidates ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 sm:px-6 lg:px-8">
      <header className="space-y-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/catalog/${catalogId}/event/${parsedEventId}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("back")}
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {detailQuery.data.title ?? t("eventFallback", { id: parsedEventId })}
        </p>
      </header>

      {canManage ? (
        <section className="space-y-4 rounded-xl border p-4 sm:p-6">
          <div>
            <h2 className="font-semibold">{t("createTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("createDescription")}</p>
          </div>
          <label className="block space-y-1 text-sm">
            <span>{t("label")}</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={255}
              className="h-10 w-full rounded-md border bg-background px-3"
              placeholder={t("labelPlaceholder")}
              disabled={isBusy}
            />
          </label>
          <div className="grid gap-5 md:grid-cols-2">
            <PosterFileInput
              title={t("square")}
              hint={t("squareHint")}
              file={squareFile}
              preview={squarePreview}
              aspectClass="aspect-square"
              onChange={setSquareFile}
              disabled={isBusy}
            />
            <PosterFileInput
              title={t("landscape")}
              hint={t("landscapeHint")}
              file={landscapeFile}
              preview={landscapePreview}
              aspectClass="aspect-video"
              onChange={setLandscapeFile}
              disabled={isBusy}
            />
          </div>
          <Button onClick={() => createMutation.mutate()} disabled={isBusy || !squareFile || !landscapeFile}>
            {createMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("create")}
          </Button>
        </section>
      ) : null}

      <section className="space-y-4">
        <div>
          <h2 className="font-semibold">{t("candidatesTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("candidatesDescription")}</p>
        </div>
        {candidatesQuery.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : candidates.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-sm text-muted-foreground">{t("empty")}</div>
        ) : (
          <div className="space-y-5">
            {candidates.map((candidate) => (
              <article key={candidate.id} className="space-y-4 rounded-xl border p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{candidate.label || t("unnamed")}</h3>
                      {candidate.published ? (
                        <Badge>{t("current")}</Badge>
                      ) : (
                        <Badge variant="outline">{t("draft")}</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("createdMeta", {
                        date: new Date(candidate.createdAt).toLocaleString(),
                        author: candidate.createdBy.name ?? candidate.createdBy.email ?? t("unknownAuthor"),
                      })}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canPublish && candidate.published ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => setConfirmation({ action: "unpublish", candidate })}
                      >
                        <Undo2 className="mr-2 h-4 w-4" />
                        {t("unpublish")}
                      </Button>
                    ) : canPublish ? (
                      <Button size="sm" disabled={isBusy} onClick={() => publishMutation.mutate(candidate.id)}>
                        <Send className="mr-2 h-4 w-4" />
                        {t("publish")}
                      </Button>
                    ) : null}
                    {canManage && !candidate.published ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => setConfirmation({ action: "delete", candidate })}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t("delete")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <CandidateImage
                    title={t("square")}
                    src={buildEventPosterCandidateImageUrl(catalogId, parsedEventId, candidate.id, "square")}
                    aspectClass="aspect-square"
                  />
                  <CandidateImage
                    title={t("landscape")}
                    src={buildEventPosterCandidateImageUrl(catalogId, parsedEventId, candidate.id, "landscape")}
                    aspectClass="aspect-video"
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <AlertDialog open={confirmation !== null} onOpenChange={(open) => !open && setConfirmation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.action === "delete" ? t("confirmDeleteTitle") : t("confirmUnpublishTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.action === "delete"
                ? t("confirmDeleteDescription", {
                    label: confirmation.candidate.label || t("unnamed"),
                  })
                : t("confirmUnpublishDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isBusy}
              className={
                confirmation?.action === "delete"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              onClick={() => {
                if (!confirmation) return;
                if (confirmation.action === "delete") {
                  deleteMutation.mutate(confirmation.candidate.id);
                } else {
                  unpublishMutation.mutate();
                }
                setConfirmation(null);
              }}
            >
              {confirmation?.action === "delete" ? t("delete") : t("unpublish")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PosterFileInput({
  title,
  hint,
  file,
  preview,
  aspectClass,
  onChange,
  disabled,
}: {
  title: string;
  hint: string;
  file: File | null;
  preview: string | null;
  aspectClass: string;
  onChange: (file: File | null) => void;
  disabled: boolean;
}) {
  return (
    <label className="space-y-2 text-sm">
      <span className="font-medium">{title}</span>
      <span className="block text-xs text-muted-foreground">{hint}</span>
      <div className={`${aspectClass} overflow-hidden rounded-lg border bg-muted`}>
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">{file?.name}</div>
        )}
      </div>
      <input
        type="file"
        accept=".jpg,.jpeg,.png,image/jpeg,image/png"
        disabled={disabled}
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
    </label>
  );
}

function CandidateImage({ title, src, aspectClass }: { title: string; src: string; aspectClass: string }) {
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <div className={`${aspectClass} overflow-hidden rounded-lg border bg-muted`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={title} className="h-full w-full object-contain" />
      </div>
    </figure>
  );
}
