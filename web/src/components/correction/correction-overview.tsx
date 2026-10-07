"use client";

// The catalog-wide view of correction: what is being corrected, how far each
// recording has got, which ones want this person, which a curator can publish
// and which nobody has started. Everything shown is read from the same span
// states as the working surface; nothing here is stored.

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  buildCorrectionOverviewUrl,
  buildCorrectionPagePath,
  buildRecordingPagePath,
} from "@/lib/api/recording-urls";
import { formatHoursMinutes } from "@/lib/correction/format";
import {
  inOverviewTab,
  isReadyToPublish,
  OVERVIEW_TABS,
  type OverviewTab,
} from "@/lib/correction/overview-status";
import {
  correctionOverviewSchema,
  type CorrectionOverview,
  type OverviewItem,
} from "./correction-types";

interface CorrectionOverviewPageProps {
  catalogId: string;
}

/** Whatever part of the date the event has: 2026, 2026-03 or 2026-03-14. */
export function formatEventDate(recording: OverviewItem["recording"]): string | null {
  if (recording.dateYear === null) return null;
  const parts = [String(recording.dateYear)];
  if (recording.dateMonth !== null) {
    parts.push(String(recording.dateMonth).padStart(2, "0"));
    if (recording.dateDay !== null) parts.push(String(recording.dateDay).padStart(2, "0"));
  }
  return parts.join("-");
}

function formatWhen(iso: string, locale: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(0, "minute");
}

/**
 * The order of a tab. What is under way lists the recordings that still want
 * this person first, then the most recently active; every other tab keeps
 * the most recently active first, as the server sends it.
 */
export function orderForTab(items: readonly OverviewItem[], tab: OverviewTab): OverviewItem[] {
  const rows = items.filter((item) => inOverviewTab(item, tab));
  if (tab !== "in_progress") return rows;
  const wantsMe = (item: OverviewItem) => ((item.mine?.open ?? 0) > 0 ? 1 : 0);
  // Array.prototype.sort is stable, so equal rows keep the server's order.
  return rows.sort((a, b) => wantsMe(b) - wantsMe(a));
}

const SEGMENTS: Array<{ state: keyof NonNullable<OverviewItem["progress"]>["seconds"]; className: string }> = [
  { state: "done", className: "bg-emerald-600" },
  { state: "needs_second_approval", className: "bg-amber-500" },
  { state: "needs_attention", className: "bg-destructive" },
  { state: "not_reviewed", className: "bg-muted-foreground/25" },
];

function ProgressBar({ item, label }: { item: OverviewItem; label: string }) {
  const progress = item.progress;
  if (!progress || progress.totalSeconds <= 0) return null;

  return (
    <div
      role="img"
      aria-label={label}
      className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
    >
      {SEGMENTS.map(({ state, className }) => (
        <div
          key={state}
          className={className}
          style={{ width: `${(progress.seconds[state] / progress.totalSeconds) * 100}%` }}
        />
      ))}
    </div>
  );
}

function SummaryTile({
  label,
  count,
  seconds,
}: {
  label: string;
  count: number;
  seconds: number;
}) {
  const t = useTranslations("correction.overview");
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-medium tabular-nums">{formatHoursMinutes(seconds)}</p>
      <p className="text-sm text-muted-foreground">{t("recordingCount", { count })}</p>
    </div>
  );
}

function OverviewRow({
  item,
  catalogId,
  canPublish,
}: {
  item: OverviewItem;
  catalogId: string;
  canPublish: boolean;
}) {
  const t = useTranslations("correction");
  const to = useTranslations("correction.overview");
  const locale = useLocale();

  const { recording, progress, mine } = item;
  const title = recording.title || recording.eventTitle || recording.audioHash.slice(0, 16);
  // The event is worth naming only when it adds something to the title.
  const eventName =
    recording.eventTitle && recording.eventTitle !== recording.title ? recording.eventTitle : null;
  const subtitle = [
    eventName,
    formatEventDate(recording),
    recording.locationName,
    formatHoursMinutes(recording.durationSeconds),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const inFlight = item.publication?.inFlight ?? null;
  const readyToPublish = isReadyToPublish(item);

  // Two badges, because the work and what readers see move independently: a
  // published recording can be under correction again.
  const workBadge: { label: string; variant: "secondary" | "outline" } | null =
    item.work === "not_started"
      ? { label: to("work.not_started"), variant: "outline" }
      : item.work === "in_progress"
        ? { label: to("work.in_progress"), variant: "outline" }
        : readyToPublish
          ? { label: to("work.ready"), variant: "secondary" }
          : null;
  const readerBadge: { label: string; variant: "default" | "secondary" | "destructive" } | null =
    item.reader === "publishing"
      ? inFlight?.error
        ? { label: to("reader.publishingStalled"), variant: "destructive" }
        : { label: to("reader.publishing"), variant: "secondary" }
      : item.reader === "current"
        ? { label: to("reader.current"), variant: "default" }
        : item.reader === "stale"
          ? { label: to("reader.stale"), variant: "secondary" }
          : null;

  const correctionHref = buildCorrectionPagePath(catalogId, recording.audioHash);

  let action: { label: string; primary: boolean };
  if (item.work === "not_started") action = { label: to("actions.start"), primary: false };
  else if (item.touchedByMe && (mine?.open ?? 0) > 0) action = { label: to("actions.continue"), primary: true };
  else if (canPublish && readyToPublish) action = { label: to("actions.publish"), primary: true };
  else action = { label: to("actions.open"), primary: false };

  // Only what is true: a row of zeros says nothing the bar does not.
  const mineParts =
    item.touchedByMe && mine
      ? [
          mine.approved > 0 ? to("mine.approved", { count: mine.approved }) : null,
          mine.waitingOnOthers > 0 ? to("mine.waiting", { count: mine.waitingOnOthers }) : null,
          mine.disapproved > 0 ? to("mine.disapproved", { count: mine.disapproved }) : null,
          mine.open > 0 ? to("mine.open", { count: mine.open }) : null,
        ].filter((part): part is string => part !== null)
      : [];

  const progressLabel = progress
    ? t("progressSummary", { done: progress.counts.done, total: progress.spanCount })
    : "";

  return (
    <li
      className="grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto] md:items-center"
      data-testid="correction-overview-row"
      data-work={item.work}
      data-reader={item.reader}
    >
      <div className="min-w-0">
        <Link
          href={buildRecordingPagePath(catalogId, recording.audioHash)}
          className="block truncate font-medium hover:underline"
        >
          {title}
        </Link>
        <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
      </div>

      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {workBadge && <Badge variant={workBadge.variant}>{workBadge.label}</Badge>}
          {readerBadge && <Badge variant={readerBadge.variant}>{readerBadge.label}</Badge>}
          {item.reader === "stale" && (
            <span className="text-xs text-muted-foreground">
              {to("changedSincePublication", { count: item.changedSinceReaderPublication })}
            </span>
          )}
        </div>

        {progress && (
          <>
            <ProgressBar item={item} label={progressLabel} />
            <p className="text-xs text-muted-foreground">
              {progressLabel}
              {progress.counts.needs_attention > 0 && (
                <span className="text-destructive">
                  {" · "}
                  {t("blockedSummary", { count: progress.counts.needs_attention })}
                </span>
              )}
              {progress.counts.needs_second_approval > 0 && (
                <>
                  {" · "}
                  {to("awaitingSecond", { count: progress.counts.needs_second_approval })}
                </>
              )}
            </p>
          </>
        )}

        {mineParts.length > 0 && (
          <p className="text-xs" data-testid="correction-overview-mine">
            <span className="font-medium">{to("mine.label")}</span> {mineParts.join(" · ")}
          </p>
        )}

        {item.lastActivity && (
          <p className="text-xs text-muted-foreground">
            {to("lastActivity", {
              name: item.lastActivity.actorName ?? t("unknownActor"),
              when: formatWhen(item.lastActivity.at, locale),
            })}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 md:justify-end">
        <Button asChild size="sm" variant={action.primary ? "default" : "outline"}>
          <Link href={correctionHref}>{action.label}</Link>
        </Button>
      </div>
    </li>
  );
}

export function CorrectionOverviewPage({ catalogId }: CorrectionOverviewPageProps) {
  const t = useTranslations("correction.overview");
  const [chosenTab, setChosenTab] = useState<OverviewTab | null>(null);

  const query = useQuery<CorrectionOverview>({
    queryKey: ["correction-overview", catalogId],
    queryFn: async () =>
      fetchJson<CorrectionOverview>(buildCorrectionOverviewUrl(catalogId), {
        schema: correctionOverviewSchema,
      }),
  });

  const data = query.data;
  const all = useMemo(
    () => (data ? [...data.workspaces, ...data.notStarted.items] : []),
    [data]
  );

  const counts = useMemo(() => {
    const result = {} as Record<OverviewTab, number>;
    for (const tab of OVERVIEW_TABS) {
      result[tab] =
        tab === "not_started" && data
          ? data.notStarted.total
          : all.filter((item) => inOverviewTab(item, tab)).length;
    }
    return result;
  }, [all, data]);

  // Land on the work that wants this person, and on what is under way when
  // nothing does.
  const tab: OverviewTab = chosenTab ?? (counts.mine > 0 ? "mine" : "in_progress");
  const rows = orderForTab(all, tab);

  const summary = data?.summary.byTab;
  const sum = (summaryTab: OverviewTab) => summary?.[summaryTab] ?? { count: 0, seconds: 0 };

  return (
    <div className="container mx-auto space-y-6 px-4 py-6">
      <div>
        <h1 className="text-lg font-medium">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {query.isLoading && <Skeleton className="h-64 w-full" />}

      {query.isError && (
        <p className="text-sm text-destructive" role="alert">
          {t("loadFailed")}
        </p>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="correction-overview-summary">
            <SummaryTile label={t("summary.notStarted")} {...sum("not_started")} />
            <SummaryTile label={t("summary.inProgress")} {...sum("in_progress")} />
            <SummaryTile label={t("summary.toPublish")} {...sum("to_publish")} />
            <SummaryTile label={t("summary.published")} {...sum("published")} />
          </div>
          {/* The tiles count the same groups as the tabs, so the figures do not
              add up to the total: a published recording that is corrected again
              is in progress and published at once. Say so rather than leave a
              reader to wonder where the hours went. */}
          <p className="-mt-3 text-xs text-muted-foreground" data-testid="correction-overview-overlap">
            {t("summary.overlap")}
          </p>

          <div className="flex flex-wrap gap-2" role="group" aria-label={t("filtersLabel")}>
            {OVERVIEW_TABS.map((candidate) => (
              <Button
                key={candidate}
                size="sm"
                variant={candidate === tab ? "default" : "outline"}
                aria-pressed={candidate === tab}
                onClick={() => setChosenTab(candidate)}
                data-testid={`correction-overview-filter-${candidate}`}
              >
                {t(`filters.${candidate}`)}
                <span className="ml-1.5 tabular-nums opacity-80">{counts[candidate]}</span>
              </Button>
            ))}
          </div>

          {tab === "not_started" && (
            <p className="text-sm text-muted-foreground">
              {t("notStartedNote")}
              {data.notStarted.total > data.notStarted.items.length &&
                ` ${t("notStartedShown", {
                  shown: data.notStarted.items.length,
                  total: data.notStarted.total,
                })}`}
            </p>
          )}

          {rows.length === 0 ? (
            <div className="rounded-lg border bg-muted/50 p-6 text-sm text-muted-foreground">
              {t(`empty.${tab}`)}
            </div>
          ) : (
            <ul className="space-y-3">
              {rows.map((item) => (
                <OverviewRow
                  key={item.recording.audioHash}
                  item={item}
                  catalogId={catalogId}
                  canPublish={data.canPublish}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
