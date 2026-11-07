"use client";

// The correction page shell: the layout gate, the deliberate start action, the
// progress summary and the publication controls. The working surface itself
// lives in correction-surface.tsx.

import Link from "next/link";
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Loader2, RotateCcw, Send, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  buildCorrectionOverviewPath,
  buildCorrectionPublicationUrl,
  buildCorrectionUrl,
  buildEventPagePath,
  buildRecordingEntryUrl,
} from "@/lib/api/recording-urls";
import { parseDuration } from "@/lib/catalog-filters";
import { formatHoursMinutes } from "@/lib/correction/format";
import { formatRecordingDate } from "@/lib/date-format";
import type { CatalogEntryWithPermissions } from "@/types/catalog";
import { CorrectionConsentCard, useContributorConsent } from "./correction-consent-card";
import { CorrectionSurface } from "./correction-surface";
import { useLandscapeWorkspace } from "./use-landscape-workspace";
import {
  correctionStateSchema,
  publishResultSchema,
  type CorrectionState,
  type PublishResult,
} from "./correction-types";

interface CorrectionWorkspaceProps {
  catalogId: string;
  hash: string;
  userId: string;
  canPublish: boolean;
  eventId: number | null;
}

export function CorrectionWorkspace({
  catalogId,
  hash,
  userId,
  canPublish,
  eventId,
}: CorrectionWorkspaceProps) {
  const t = useTranslations("correction");
  const locale = useLocale();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const supported = useLandscapeWorkspace();

  const consentQuery = useContributorConsent();

  const stateQuery = useQuery<CorrectionState>({
    queryKey: ["correction-state", catalogId, hash],
    queryFn: async () =>
      fetchJson<CorrectionState>(buildCorrectionUrl(catalogId, hash), {
        schema: correctionStateSchema,
      }),
    enabled: supported === true,
    // Publication waits for the search index, which runs on the host worker
    // and takes minutes. While a publication is in flight the page polls, so
    // the curator sees it finish, or fail, without reloading.
    refetchInterval: (query) => {
      const active = query.state.data?.activePublication;
      return active && !active.error && active.status !== "PENDING" ? 5_000 : false;
    },
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
  const recordingDate = formatRecordingDate(
    recording?.dateYear,
    recording?.dateMonth,
    recording?.dateDay,
    locale,
  );
  const durationSeconds =
    parseDuration(recording?.duration) ?? stateQuery.data?.workspace?.spanDurationSeconds;
  const recordingHeading = [
    recordingDate,
    recording?.location?.name,
    durationSeconds === undefined ? null : formatHoursMinutes(durationSeconds),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const headingText = recordingHeading || hash.slice(0, 16);

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
      fetchJson<PublishResult>(buildCorrectionPublicationUrl(catalogId, hash), {
        method: "POST",
        schema: publishResultSchema,
      }),
    onSuccess: (result) => {
      refreshState();
      if (result.status === "FAILED") {
        toast({
          description: result.error ? `${t("publishFailed")}: ${result.error.message}` : t("publishFailed"),
          variant: "destructive",
        });
      }
    },
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
          <Link href={buildCorrectionOverviewPath(catalogId)}>
            {t("overviewLink")}
          </Link>
        </Button>
      </div>
    );
  }

  const state = stateQuery.data;
  // Nothing is written before the contributor terms are accepted (ADR 0012).
  const consent = consentQuery.data?.consent;
  const needsConsent = consent !== undefined && !consent.accepted;

  return (
    <div className="container mx-auto space-y-4 px-4 py-4">
      <header
        className="flex flex-col gap-3 border-b pb-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6"
        data-testid="correction-header"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {/* The header back control leads to the correction overview. */}
            <span>{t("pageTitle")}</span>
          </div>
          <h1 className="break-words text-lg font-medium">
            {eventId !== null ? (
              <Link
                href={buildEventPagePath(catalogId, eventId)}
                className="underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-current"
              >
                {headingText}
              </Link>
            ) : headingText}
          </h1>
          {state?.workspace && (
            <p className="break-all text-xs text-muted-foreground">
              {state.workspace.sourceBackend}
            </p>
          )}
        </div>

        <div className="flex flex-col items-start gap-2 lg:max-w-md lg:shrink-0 lg:items-end lg:text-right">
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
                  {t("blockedSummary", {
                    count: state.progress.blockedSpanCount,
                  })}
                </Badge>
              )}
              {state.workspace.readerPublicationId && (
                <Badge>{t("published")}</Badge>
              )}
            </div>
          )}
          {canPublish && state?.workspace && state.publication && (
            <div
              role="group"
              aria-label={t("publishTitle")}
              className="space-y-1.5"
              data-testid="publication-card"
            >
              <div className="flex flex-col items-start gap-1.5 lg:items-end">
                <div className="flex flex-wrap items-center gap-2">
                  {/*
                    Publishing runs inside the request, so a PENDING row the page
                    sees is a leftover from a crash between manifest and render:
                    nothing is running, and the retry picks it up like an error.
                  */}
                  {state.activePublication &&
                  state.activePublication.status !== "ROLLING_BACK" &&
                  (state.activePublication.error ||
                    state.activePublication.status === "PENDING") ? (
                    <Button
                      className="gap-2"
                      disabled={publish.isPending}
                      onClick={() => publish.mutate()}
                    >
                      {publish.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcw className="h-4 w-4" />
                      )}
                      {t("retryPublish")}
                    </Button>
                  ) : (
                    <Button
                      className="gap-2"
                      disabled={
                        !state.publication.eligible ||
                        publish.isPending ||
                        state.activePublication !== null
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
                  )}
                  {state.workspace.readerPublicationId && (
                    <Button
                      variant="outline"
                      className="gap-2"
                      // Serialized behind an in-flight publication on the
                      // server; disabled here so the refusal is not a surprise.
                      disabled={
                        unpublish.isPending || state.activePublication !== null
                      }
                      onClick={() => unpublish.mutate()}
                    >
                      <Undo2 className="h-4 w-4" />
                      {t("unpublish")}
                    </Button>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {state.publication.eligible
                      ? t("publishEligible")
                      : t("publishBlocked")}
                  </p>
                  {state.workspace.readerPublicationId && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("unpublishedKeepsSearch")}
                    </p>
                  )}
                  {state.activePublication &&
                    !state.activePublication.error &&
                    state.activePublication.status !== "PENDING" && (
                      <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {state.activePublication.status === "ROLLING_BACK"
                          ? t("rollbackInFlight")
                          : t("publishInFlight")}
                      </p>
                    )}
                  {state.activePublication?.error && (
                    <p
                      className="mt-1 text-xs text-destructive"
                      data-testid="publication-error"
                    >
                      {t("publishStalled", {
                        code: state.activePublication.error.code,
                        message: state.activePublication.error.message,
                      })}
                    </p>
                  )}
                  {state.activePublication?.status === "PENDING" &&
                    !state.activePublication.error && (
                      <p
                        className="mt-1 text-xs text-destructive"
                        data-testid="publication-error"
                      >
                        {t("publishInterrupted")}
                      </p>
                    )}
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      {stateQuery.isLoading && <Skeleton className="h-64 w-full" />}

      {state && !state.workspace && !state.canStart && (
        <div className="rounded-lg border bg-muted/50 p-6">
          <h2 className="font-medium">{t("notEligible")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("notEligibleDescription")}
          </p>
        </div>
      )}

      {state && consent && needsConsent && (state.workspace || state.canStart) && (
        <CorrectionConsentCard consent={consent} guide={state.guide.body} />
      )}

      {/* Without the consent answer nothing can be shown or written, so a
          failed lookup says so instead of leaving an empty page. */}
      {state && (state.workspace || state.canStart) && consentQuery.isLoading && (
        <Skeleton className="h-24 w-full" />
      )}
      {state && (state.workspace || state.canStart) && consentQuery.isError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6" data-testid="correction-consent-error">
          <p className="text-sm">{t("consentLoadFailed")}</p>
          <Button variant="outline" className="mt-3" onClick={() => consentQuery.refetch()}>
            {t("consentRetry")}
          </Button>
        </div>
      )}

      {state?.canStart && !state.workspace && consent?.accepted && (
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
          {consent?.accepted && (
            <CorrectionSurface
              key={`${state.workspace.id}:${userId}`}
              catalogId={catalogId}
              hash={hash}
              userId={userId}
              workspace={state.workspace}
              resume={state.resume}
              guide={state.guide.body}
              onChanged={refreshState}
            />
          )}
        </>
      )}
    </div>
  );
}
