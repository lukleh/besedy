"use client";

// The correction page shell: the layout gate, the deliberate start action, the
// progress summary and the publication controls. The working surface itself
// lives in correction-surface.tsx.

import Link from "next/link";
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeft, Loader2, Send, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  buildCorrectionPublicationUrl,
  buildCorrectionUrl,
  buildRecordingEntryUrl,
  buildRecordingPagePath,
} from "@/lib/api/recording-urls";
import type { CatalogEntryWithPermissions } from "@/types/catalog";
import { CorrectionSurface } from "./correction-surface";
import { useLandscapeWorkspace } from "./use-landscape-workspace";
import { correctionStateSchema, type CorrectionState } from "./correction-types";

interface CorrectionWorkspaceProps {
  catalogId: string;
  hash: string;
  userId: string;
  canPublish: boolean;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

export function CorrectionWorkspace({
  catalogId,
  hash,
  userId,
  canPublish,
}: CorrectionWorkspaceProps) {
  const t = useTranslations("correction");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const supported = useLandscapeWorkspace();

  const stateQuery = useQuery<CorrectionState>({
    queryKey: ["correction-state", catalogId, hash],
    queryFn: async () =>
      fetchJson<CorrectionState>(buildCorrectionUrl(catalogId, hash), {
        schema: correctionStateSchema,
      }),
    enabled: supported === true,
    // Publication waits for the search index, which runs on the host worker
    // and takes minutes. While a publication is in flight the page polls, so
    // the curator sees it finish without reloading.
    refetchInterval: (query) =>
      query.state.data?.workspace?.lockedByPublicationId ? 5_000 : false,
  });

  // The surface always says which recording it is working on (ADR 0006): a
  // corrector with several in progress, or a curator about to publish, must
  // never have to trust the URL.
  const entryQuery = useQuery<CatalogEntryWithPermissions>({
    queryKey: ["recording-entry", catalogId, hash],
    queryFn: async () =>
      fetchJson<CatalogEntryWithPermissions>(buildRecordingEntryUrl(catalogId, hash)),
    enabled: supported === true,
  });
  const recording = entryQuery.data?.entry;
  const recordingTitle =
    recording?.curatedTitle || recording?.title || recording?.filename || hash.slice(0, 16);
  const recordingDate = recording?.curatedDate || recording?.date || null;
  const recordingSubtitle = [recordingDate, recording?.album?.name]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const refreshState = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["correction-state", catalogId, hash],
    });
  }, [queryClient, catalogId, hash]);

  const start = useMutation({
    mutationFn: async (expectedBackend: string | null) =>
      fetchJson(buildCorrectionUrl(catalogId, hash), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedBackend }),
      }),
    onSuccess: refreshState,
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  const publish = useMutation({
    mutationFn: async () =>
      fetchJson(buildCorrectionPublicationUrl(catalogId, hash), { method: "POST" }),
    onSuccess: refreshState,
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : t("publishFailed"),
        variant: "destructive",
      }),
  });

  const unpublish = useMutation({
    mutationFn: async () =>
      fetchJson(buildCorrectionPublicationUrl(catalogId, hash), { method: "DELETE" }),
    onSuccess: refreshState,
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  if (supported === null) {
    return (
      <div className="container mx-auto space-y-4 px-4 py-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!supported) {
    return (
      <div className="container mx-auto max-w-lg px-4 py-12 text-center">
        <h1 className="text-lg font-medium">{t("landscapeOnly")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("landscapeOnlyDescription")}
        </p>
        <Button asChild variant="outline" className="mt-6">
          <Link href={buildRecordingPagePath(catalogId, hash)}>
            {t("backToRecording")}
          </Link>
        </Button>
      </div>
    );
  }

  const state = stateQuery.data;

  return (
    <div className="container mx-auto space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm" className="gap-2">
            <Link href={buildRecordingPagePath(catalogId, hash)}>
              <ArrowLeft className="h-4 w-4" />
              {t("backToRecording")}
            </Link>
          </Button>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("pageTitle")}
            </p>
            <h1 className="text-lg font-medium">{recordingTitle}</h1>
            {recordingSubtitle && (
              <p className="text-sm text-muted-foreground">{recordingSubtitle}</p>
            )}
          </div>
        </div>

        {state?.workspace && state.progress && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>
              {t("progressSummary", {
                done: state.progress.doneSpanCount,
                total: state.progress.spanCount,
              })}
            </span>
            {state.progress.blockedSpanCount > 0 && (
              <Badge variant="destructive">
                {state.progress.blockedSpanCount === 1
                  ? t("blockedSummary", { count: 1 })
                  : t("blockedSummaryPlural", {
                      count: state.progress.blockedSpanCount,
                    })}
              </Badge>
            )}
            {state.workspace.readerPublicationId && (
              <Badge>{t("published")}</Badge>
            )}
          </div>
        )}
      </div>

      {stateQuery.isLoading && <Skeleton className="h-64 w-full" />}

      {state && !state.workspace && !state.canStart && (
        <div className="rounded-lg border bg-muted/50 p-6">
          <h2 className="font-medium">{t("notEligible")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("notEligibleDescription")}
          </p>
        </div>
      )}

      {state?.canStart && !state.workspace && (
        <div className="rounded-lg border p-6">
          <h2 className="font-medium">{t("startTitle")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t("startDescription")}
          </p>
          {state.candidateBackend ? (
            <>
              <p className="mt-3 font-mono text-sm">
                {t("startFrom", { backend: state.candidateBackend })}
              </p>
              <Button
                className="mt-4 gap-2"
                disabled={start.isPending}
                onClick={() => start.mutate(state.candidateBackend)}
              >
                {start.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("start")}
              </Button>
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {t("startNoSource")}
            </p>
          )}
        </div>
      )}

      {state?.workspace && (
        <>
          {canPublish && state.publication && (
            <div className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-medium">{t("publishTitle")}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {state.publication.eligible
                      ? t("publishEligible")
                      : t("publishBlocked")}
                  </p>
                  {state.workspace.readerPublicationId && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("unpublishedKeepsSearch")}
                    </p>
                  )}
                  {state.workspace.lockedByPublicationId && (
                    <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {t("publishInFlight")}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    className="gap-2"
                    disabled={
                      !state.publication.eligible ||
                      publish.isPending ||
                      state.workspace.lockedByPublicationId !== null
                    }
                    onClick={() => publish.mutate()}
                  >
                    {publish.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    {state.workspace.readerPublicationId
                      ? t("republish")
                      : t("publish")}
                  </Button>
                  {state.workspace.readerPublicationId && (
                    <Button
                      variant="outline"
                      className="gap-2"
                      disabled={unpublish.isPending}
                      onClick={() => unpublish.mutate()}
                    >
                      <Undo2 className="h-4 w-4" />
                      {t("unpublish")}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              {t("guide")}
            </summary>
            <pre className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
              {state.guide.body}
            </pre>
          </details>

          <p className="text-xs text-muted-foreground">
            {t("frozenSource", { backend: state.workspace.sourceBackend })} ·{" "}
            {formatDuration(state.workspace.spanDurationSeconds)}
          </p>

          <CorrectionSurface
            catalogId={catalogId}
            hash={hash}
            userId={userId}
            workspace={state.workspace}
            resume={state.resume}
            onChanged={refreshState}
          />
        </>
      )}
    </div>
  );
}
