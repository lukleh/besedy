"use client";

import type { FormEvent, ReactNode } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Mic, Play } from "lucide-react";
import { CatalogSearchBar } from "@/components/catalog/catalog-search-bar";
import { Button } from "@/components/ui/button";
import { formatMediumDate, formatPartialDate } from "@/lib/date-format";
import type { RagSearchResult } from "../hooks/use-rag-search";

export function formatSeekTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return [hours, minutes, secs]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

interface RagSearchBarProps {
  ragQuery: string;
  setRagQuery: (query: string) => void;
  isRagMode: boolean;
  ragLoading: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
  onClear: () => void;
  secondaryAction?: ReactNode;
}

export function RagSearchBar({
  ragQuery,
  setRagQuery,
  isRagMode,
  ragLoading,
  onSubmit,
  onBack,
  onClear,
  secondaryAction,
}: RagSearchBarProps) {
  const t = useTranslations("catalog");

  return (
    <CatalogSearchBar
      value={ragQuery}
      onChange={setRagQuery}
      placeholder={t("ragSearch.placeholder")}
      ariaLabel={t("ragSearch.placeholder")}
      onSubmit={onSubmit}
      onClear={onClear}
      clearLabel={t("ragSearch.clear")}
      submitLabel={t("ragSearch.submit")}
      submitDisabled={ragLoading || !ragQuery.trim()}
      submitLoading={ragLoading}
      showBackButton={isRagMode}
      onBack={onBack}
      backLabel={t("ragSearch.back")}
      formTestId="rag-search-form"
      inputTestId="catalog-rag-search-input"
      secondaryAction={secondaryAction}
    />
  );
}

interface RagSearchResultsProps {
  results: RagSearchResult[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenResult: (result: RagSearchResult) => void;
}

export function RagSearchResults({
  results,
  loading,
  error,
  onRetry,
  onOpenResult,
}: RagSearchResultsProps) {
  const t = useTranslations("catalog");
  const locale = useLocale();

  return (
    <div className="space-y-3">
      {loading && (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          {t("ragSearch.loading")}
        </div>
      )}

      {!loading && error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{error}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={onRetry}
          >
            {t("ragSearch.retry")}
          </Button>
        </div>
      )}

      {!loading && !error && results.length === 0 && (
        <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          {t("ragSearch.noResults")}
        </div>
      )}

      {!loading && !error && results.length > 0 && (
        <div className="space-y-2">
          {results.map((result) => {
            const hasFullDate =
              result.metadata.date?.year &&
              result.metadata.date?.month &&
              result.metadata.date?.day;
            const formattedTitle = hasFullDate
              ? formatMediumDate(
                  result.metadata.date!.year!,
                  result.metadata.date!.month!,
                  result.metadata.date!.day!,
                  locale,
                )
              : result.metadata.date
                ? formatPartialDate(
                    result.metadata.date.year ?? null,
                    result.metadata.date.month ?? null,
                    result.metadata.date.day ?? null,
                    locale,
                  )
                : null;
            const hasLocation = !!result.metadata.location?.name;
            const timestamp = formatSeekTimestamp(result.startSec);

            return (
              <div
                key={result.chunkId}
                className="rounded-lg border bg-card p-3"
              >
                {/* Result number + title: date · location */}
                <div className="font-medium">
                  <span className="text-muted-foreground">#{result.rank}</span>
                  {(formattedTitle || hasLocation) && (
                    <>
                      <span className="text-muted-foreground">{" · "}</span>
                      {formattedTitle && <span>{formattedTitle}</span>}
                      {formattedTitle && hasLocation && <span> · </span>}
                      {hasLocation && (
                        <span>{result.metadata.location!.name}</span>
                      )}
                    </>
                  )}
                </div>
                {/* Metadata row: open button + recorder */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-sm">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onOpenResult(result)}
                  >
                    <Play className="mr-2 h-4 w-4" />
                    {t("ragSearch.openAtTimestamp", { time: timestamp })}
                  </Button>
                  {result.metadata.recorder?.name && (
                    <span className="inline-flex items-center gap-1 shrink-0">
                      <Mic className="h-3 w-3 text-muted-foreground" />
                      {result.metadata.recorder.name}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-foreground">
                  {result.text}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
