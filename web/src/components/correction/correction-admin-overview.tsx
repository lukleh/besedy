"use client";

// Correction as the person who looks after it sees it: every recording under
// way grouped by event day, the people doing the work, and what is waiting for
// somebody. It reads the corrector's overview plus who did what; nothing here
// is stored and nothing here can be changed.

import Link from "next/link";
import { createContext, Fragment, useContext, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SessionOrdinalBadge } from "@/components/catalog/session-ordinal-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  buildCorrectionOverviewPath,
  buildCorrectionPagePath,
} from "@/lib/api/recording-urls";
import { formatClock, formatHoursMinutes } from "@/lib/correction/format";
import { isReadyToPublish } from "@/lib/correction/overview-status";
import type { SpanState } from "@/lib/correction/span-state";
import { formatEventDate, formatWhen, ProgressBar, SEGMENTS } from "./correction-overview";
import {
  correctionAdminOverviewSchema,
  type CorrectionAdminOverview,
  type OverviewItem,
} from "./correction-types";

/** Work nobody has touched for this long is called out. */
export const STALLED_AFTER_DAYS = 14;

/** How many rows each needs-action list shows. */
const ACTION_LIST_LIMIT = 6;

type Contributors = CorrectionAdminOverview["contributors"];

export interface RecordingGroup {
  key: string;
  /** In session order */
  items: OverviewItem[];
  seconds: Record<SpanState, number>;
  totalSeconds: number;
  lastActivityAt: string | null;
}

function secondsOf(item: OverviewItem): Record<SpanState, number> {
  return (
    item.progress?.seconds ?? {
      done: 0,
      needs_second_approval: 0,
      needs_attention: 0,
      // A recording nobody has started is all still to review.
      not_reviewed: item.recording.durationSeconds,
    }
  );
}

/**
 * Recordings grouped by the day and place of their event, which is what a
 * gathering with several sessions shares. A recording without a visible
 * event stands alone. Only groups where correction has begun are returned,
 * the most recently active first; their sessions nobody has started are
 * included so that what is left covers the whole day.
 */
export function groupRecordings(items: readonly OverviewItem[]): RecordingGroup[] {
  const groups = new Map<string, RecordingGroup>();
  for (const item of items) {
    const { recording } = item;
    const key =
      recording.eventId === null
        ? `recording:${recording.audioHash}`
        : `${recording.dateYear}-${recording.dateMonth}-${recording.dateDay}|${recording.locationName}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        items: [],
        seconds: { done: 0, needs_second_approval: 0, needs_attention: 0, not_reviewed: 0 },
        totalSeconds: 0,
        lastActivityAt: null,
      };
      groups.set(key, group);
    }
    group.items.push(item);
    const seconds = secondsOf(item);
    for (const { state } of SEGMENTS) {
      group.seconds[state] += seconds[state];
      group.totalSeconds += seconds[state];
    }
    const at = item.lastActivity?.at ?? null;
    if (at !== null && (group.lastActivityAt === null || at > group.lastActivityAt)) {
      group.lastActivityAt = at;
    }
  }

  const started = [...groups.values()].filter((group) =>
    group.items.some((item) => item.work !== "not_started")
  );
  for (const group of started) {
    group.items.sort(
      (a, b) => (a.recording.sessionOrdinal ?? 0) - (b.recording.sessionOrdinal ?? 0)
    );
  }
  // ISO timestamps order as text.
  return started.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
}

function isStalled(iso: string | null | undefined, now: number): boolean {
  return iso != null && now - new Date(iso).getTime() > STALLED_AFTER_DAYS * 86_400_000;
}

/** A second pass is impossible while only one person has ever worked here. */
function hasSoleCorrector(item: OverviewItem, contributors: Contributors): boolean {
  return (
    (item.progress?.seconds.needs_second_approval ?? 0) > 0 &&
    item.workspaceId !== null &&
    (contributors[item.workspaceId]?.length ?? 0) === 1
  );
}

export interface NeedsAction {
  /** Recordings with audio waiting for a second person, most audio first */
  secondPass: OverviewItem[];
  soleCorrector: OverviewItem[];
  ready: OverviewItem[];
  stale: OverviewItem[];
  stalled: OverviewItem[];
}

export function deriveNeedsAction(
  workspaces: readonly OverviewItem[],
  contributors: Contributors,
  now: number
): NeedsAction {
  const waiting = (item: OverviewItem) => item.progress?.seconds.needs_second_approval ?? 0;
  return {
    secondPass: workspaces.filter((item) => waiting(item) > 0).sort((a, b) => waiting(b) - waiting(a)),
    soleCorrector: workspaces.filter((item) => hasSoleCorrector(item, contributors)),
    ready: workspaces.filter(isReadyToPublish),
    stale: workspaces.filter((item) => item.reader === "stale"),
    stalled: workspaces.filter(
      (item) => item.work === "in_progress" && isStalled(item.lastActivity?.at, now)
    ),
  };
}

function useItemTitle() {
  const tEvents = useTranslations("events.list");
  const locale = useLocale();
  // Named like the catalog's event list, by date and place; a recording whose
  // event this person cannot see falls back to its own title.
  return (item: OverviewItem): string => {
    const eventDate = formatEventDate(item.recording, locale);
    return eventDate
      ? `${eventDate} · ${item.recording.locationName ?? tEvents("unknownLocation")}`
      : item.recording.title || item.recording.audioHash.slice(0, 16);
  };
}

/** When the shown data arrived: the moment every age on the page is measured from. */
const LoadedAtContext = createContext(0);

function When({ iso }: { iso: string }) {
  const locale = useLocale();
  const stalled = isStalled(iso, useContext(LoadedAtContext));
  return (
    <span className={stalled ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}>
      {formatWhen(iso, locale)}
    </span>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-medium tabular-nums">{value}</p>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function RecordingStatus({
  item,
  contributors,
}: {
  item: OverviewItem;
  contributors: Contributors;
}) {
  const t = useTranslations("correction.admin.events");
  const to = useTranslations("correction.overview");
  const tc = useTranslations("correction");

  if (item.work === "not_started") {
    return <span className="text-muted-foreground">{t("notStartedYet")}</span>;
  }
  const people = item.workspaceId ? (contributors[item.workspaceId] ?? []) : [];
  return (
    <div className="space-y-1">
      <p className="truncate">{people.map((person) => person.name ?? tc("unknownActor")).join(", ")}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {item.lastActivity && <When iso={item.lastActivity.at} />}
        {isReadyToPublish(item) && <Badge variant="secondary">{to("work.ready")}</Badge>}
        {item.reader === "stale" && <Badge variant="secondary">{to("reader.stale")}</Badge>}
        {hasSoleCorrector(item, contributors) && <Badge variant="outline">{t("soleCorrector")}</Badge>}
      </div>
    </div>
  );
}

function RecordingRow({
  item,
  catalogId,
  contributors,
  nested,
}: {
  item: OverviewItem;
  catalogId: string;
  contributors: Contributors;
  nested: boolean;
}) {
  const tc = useTranslations("correction");
  const itemTitle = useItemTitle();
  const seconds = secondsOf(item);
  const total = SEGMENTS.reduce((sum, { state }) => sum + seconds[state], 0);
  const label = item.progress
    ? tc("progressSummary", { done: item.progress.counts.done, total: item.progress.spanCount })
    : "";

  return (
    <TableRow data-testid="correction-admin-recording">
      <TableCell className={nested ? "pl-10" : undefined}>
        <Link
          href={buildCorrectionPagePath(catalogId, item.recording.audioHash)}
          className="flex min-w-0 items-center gap-2 hover:underline"
        >
          <span className="truncate">
            {nested ? item.recording.title || item.recording.audioHash.slice(0, 16) : itemTitle(item)}
          </span>
          <SessionOrdinalBadge
            sessionOrdinal={item.recording.sessionOrdinal ?? undefined}
            sessionCount={item.recording.sessionCount ?? undefined}
          />
        </Link>
        <p className="text-xs text-muted-foreground">{formatHoursMinutes(total)}</p>
      </TableCell>
      <TableCell>
        <ProgressBar progress={{ seconds, totalSeconds: total }} label={label} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatHoursMinutes(total - seconds.done)}</TableCell>
      <TableCell>
        <RecordingStatus item={item} contributors={contributors} />
      </TableCell>
    </TableRow>
  );
}

function GroupRows({
  group,
  catalogId,
  contributors,
}: {
  group: RecordingGroup;
  catalogId: string;
  contributors: Contributors;
}) {
  const t = useTranslations("correction.admin.events");
  const to = useTranslations("correction.overview");
  const tc = useTranslations("correction");
  const itemTitle = useItemTitle();
  const [open, setOpen] = useState(false);

  if (group.items.length === 1) {
    return (
      <RecordingRow item={group.items[0]} catalogId={catalogId} contributors={contributors} nested={false} />
    );
  }

  const names = [
    ...new Set(
      group.items.flatMap((item) =>
        (item.workspaceId ? (contributors[item.workspaceId] ?? []) : []).map(
          (person) => person.name ?? tc("unknownActor")
        )
      )
    ),
  ];
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <>
      <TableRow data-testid="correction-admin-group">
        <TableCell>
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 text-left font-medium hover:underline"
            aria-expanded={open}
            aria-label={`${itemTitle(group.items[0])}: ${t(open ? "collapse" : "expand")}`}
            onClick={() => setOpen(!open)}
          >
            <Chevron className="h-4 w-4 shrink-0" aria-hidden />
            <span className="truncate">{itemTitle(group.items[0])}</span>
          </button>
          <p className="pl-[22px] text-xs text-muted-foreground">
            {to("recordingCount", { count: group.items.length })} · {formatHoursMinutes(group.totalSeconds)}
          </p>
        </TableCell>
        <TableCell>
          <ProgressBar progress={group} label={itemTitle(group.items[0])} />
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {formatHoursMinutes(group.totalSeconds - group.seconds.done)}
        </TableCell>
        <TableCell>
          <p className="truncate">{names.join(", ")}</p>
          {group.lastActivityAt && (
            <p className="text-xs">
              <When iso={group.lastActivityAt} />
            </p>
          )}
        </TableCell>
      </TableRow>
      {open &&
        group.items.map((item) => (
          <RecordingRow
            key={item.recording.audioHash}
            item={item}
            catalogId={catalogId}
            contributors={contributors}
            nested
          />
        ))}
    </>
  );
}

function ActionCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-2 space-y-2 text-sm">{children}</div>
    </div>
  );
}

function RecordingLinks({
  items,
  catalogId,
  detail,
}: {
  items: OverviewItem[];
  catalogId: string;
  detail?: (item: OverviewItem) => React.ReactNode;
}) {
  const t = useTranslations("correction.admin.action");
  const itemTitle = useItemTitle();
  if (items.length === 0) return <p className="text-muted-foreground">{t("none")}</p>;
  return (
    <ul className="divide-y">
      {items.slice(0, ACTION_LIST_LIMIT).map((item) => (
        <li key={item.recording.audioHash} className="py-1.5">
          <Link
            href={buildCorrectionPagePath(catalogId, item.recording.audioHash)}
            className="flex min-w-0 items-center gap-2 hover:underline"
          >
            <span className="truncate">{itemTitle(item)}</span>
            <SessionOrdinalBadge
              sessionOrdinal={item.recording.sessionOrdinal ?? undefined}
              sessionCount={item.recording.sessionCount ?? undefined}
            />
          </Link>
          {detail && <p className="text-xs text-muted-foreground">{detail(item)}</p>}
        </li>
      ))}
      {items.length > ACTION_LIST_LIMIT && (
        <li className="py-1.5 text-xs text-muted-foreground">
          {t("more", { count: items.length - ACTION_LIST_LIMIT })}
        </li>
      )}
    </ul>
  );
}

interface CorrectionAdminOverviewPageProps {
  catalogId: string;
}

export function CorrectionAdminOverviewPage({ catalogId }: CorrectionAdminOverviewPageProps) {
  const t = useTranslations("correction.admin");
  const tc = useTranslations("correction");
  const locale = useLocale();
  const itemTitle = useItemTitle();

  const query = useQuery<CorrectionAdminOverview>({
    queryKey: ["correction-admin-overview", catalogId],
    queryFn: async () =>
      fetchJson<CorrectionAdminOverview>("/api/admin/corrections", {
        schema: correctionAdminOverviewSchema,
      }),
  });
  const data = query.data;
  const now = query.dataUpdatedAt;

  const view = useMemo(() => {
    if (!data) return null;
    const groups = groupRecordings([...data.workspaces, ...data.notStarted.items]);
    const itemByHash = new Map(data.workspaces.map((item) => [item.recording.audioHash, item]));
    const sum = (state: SpanState) =>
      data.workspaces.reduce((total, item) => total + (item.progress?.seconds[state] ?? 0), 0);
    // Sessions nobody has started that already show inside a group whose
    // other sessions are under way.
    const shownNotStarted = groups.flatMap((group) =>
      group.items.filter((item) => item.work === "not_started")
    );
    const activeThisWeek = data.people.filter(
      (person) => now - new Date(person.lastActivityAt).getTime() < 7 * 86_400_000
    );
    return {
      groups,
      itemByHash,
      action: deriveNeedsAction(data.workspaces, data.contributors, now),
      doneSeconds: sum("done"),
      secondPassSeconds: sum("needs_second_approval"),
      totalSeconds:
        data.workspaces.reduce((total, item) => total + (item.progress?.totalSeconds ?? 0), 0) +
        data.summary.byTab.not_started.seconds,
      activePeople: activeThisWeek.length,
      approvedThisWeek: data.people.reduce((total, person) => total + person.approvedSeconds7d, 0),
      untouched: {
        count: data.notStarted.total - shownNotStarted.length,
        seconds:
          data.summary.byTab.not_started.seconds -
          shownNotStarted.reduce((total, item) => total + item.recording.durationSeconds, 0),
      },
    };
  }, [data, now]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href={buildCorrectionOverviewPath(catalogId)}>{t("correctorOverview")}</Link>
        </Button>
      </div>

      {query.isLoading && <Skeleton className="h-64 w-full" />}

      {query.isError && (
        <p className="text-sm text-destructive" role="alert">
          {t("loadFailed")}
        </p>
      )}

      {data && view && (
        <LoadedAtContext.Provider value={now}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="correction-admin-summary">
            <Tile
              label={t("summary.done")}
              value={formatHoursMinutes(view.doneSeconds)}
              detail={t("summary.doneOf", { total: formatHoursMinutes(view.totalSeconds) })}
            />
            <Tile
              label={t("summary.secondPass")}
              value={formatHoursMinutes(view.secondPassSeconds)}
              detail={tc("overview.recordingCount", { count: view.action.secondPass.length })}
            />
            <Tile
              label={t("summary.attention")}
              value={String(data.disputes.total)}
              detail={t("summary.attentionCount", { count: data.disputes.total })}
            />
            <Tile
              label={t("summary.active")}
              value={t("summary.activePeople", { count: view.activePeople })}
              detail={t("summary.activeApproved", { hours: formatHoursMinutes(view.approvedThisWeek) })}
            />
          </div>

          <section className="space-y-3">
            <h2 className="font-medium">{t("events.title")}</h2>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {SEGMENTS.map(({ state, className }) => (
                <li key={state} className="flex items-center gap-1.5">
                  <span className={`h-2.5 w-2.5 rounded-sm ${className}`} aria-hidden />
                  {t(`legend.${state}`)}
                </li>
              ))}
            </ul>
            {view.groups.length === 0 ? (
              <p className="rounded-lg border bg-muted/50 p-6 text-sm text-muted-foreground">
                {t("events.empty")}
              </p>
            ) : (
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[32%]">{t("events.event")}</TableHead>
                    <TableHead>{t("events.progress")}</TableHead>
                    <TableHead className="w-28 text-right">{t("events.left")}</TableHead>
                    <TableHead className="w-[26%]">{t("events.who")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.groups.map((group) => (
                    <GroupRows
                      key={group.key}
                      group={group}
                      catalogId={catalogId}
                      contributors={data.contributors}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
            {view.untouched.count > 0 && (
              <p className="text-sm text-muted-foreground">
                {t("events.notStarted", {
                  count: view.untouched.count,
                  hours: formatHoursMinutes(view.untouched.seconds),
                })}
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="font-medium">{t("people.title")}</h2>
            {data.people.length === 0 ? (
              <p className="rounded-lg border bg-muted/50 p-6 text-sm text-muted-foreground">
                {t("people.empty")}
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("people.person")}</TableHead>
                      <TableHead>{t("people.workingOn")}</TableHead>
                      <TableHead className="text-right">{t("people.days7")}</TableHead>
                      <TableHead className="text-right">{t("people.days30")}</TableHead>
                      <TableHead className="text-right">{t("people.waiting")}</TableHead>
                      <TableHead className="text-right">{t("people.disputed")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.people.map((person, index) => {
                      const last = view.itemByHash.get(person.lastAudioHash);
                      return (
                        // People carry no id here; the list is fixed per response.
                        <TableRow key={index} data-testid="correction-admin-person">
                          <TableCell>
                            <p className="font-medium">{person.name ?? tc("unknownActor")}</p>
                            <p className="text-xs">
                              <When iso={person.lastActivityAt} />
                            </p>
                          </TableCell>
                          <TableCell>
                            {last && (
                              <Link
                                href={buildCorrectionPagePath(catalogId, person.lastAudioHash)}
                                className="flex min-w-0 items-center gap-2 hover:underline"
                              >
                                <span className="truncate">{itemTitle(last)}</span>
                                <SessionOrdinalBadge
                                  sessionOrdinal={last.recording.sessionOrdinal ?? undefined}
                                  sessionCount={last.recording.sessionCount ?? undefined}
                                />
                              </Link>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatHoursMinutes(person.approvedSeconds7d)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatHoursMinutes(person.approvedSeconds30d)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatHoursMinutes(person.waitingSeconds)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{person.disputedCount}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <p className="text-xs text-muted-foreground">{t("people.hint")}</p>
              </>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="font-medium">{t("action.title")}</h2>
            <div className="grid gap-3 lg:grid-cols-3">
              <ActionCard title={t("action.secondPass")} hint={t("action.secondPassHint")}>
                <RecordingLinks
                  items={view.action.secondPass}
                  catalogId={catalogId}
                  detail={(item) => {
                    const firstPass = (item.workspaceId ? (data.contributors[item.workspaceId] ?? []) : [])
                      .filter((person) => person.waitingSeconds > 0)
                      .map((person) => person.name ?? tc("unknownActor"));
                    const hours = formatHoursMinutes(item.progress?.seconds.needs_second_approval ?? 0);
                    return firstPass.length > 0
                      ? `${hours} · ${t("action.firstPassBy", { names: firstPass.join(", ") })}`
                      : hours;
                  }}
                />
                {view.action.soleCorrector.length > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="correction-admin-sole">
                    {t("action.soleCorrector", { count: view.action.soleCorrector.length })}
                  </p>
                )}
              </ActionCard>

              <ActionCard title={t("action.disputes")} hint={t("action.disputesHint")}>
                {data.disputes.items.length === 0 ? (
                  <p className="text-muted-foreground">{t("action.none")}</p>
                ) : (
                  <ul className="divide-y">
                    {data.disputes.items.slice(0, ACTION_LIST_LIMIT).map((dispute) => {
                      const item = view.itemByHash.get(dispute.audioHash);
                      const names = dispute.objectorNames.map((name) => name ?? tc("unknownActor"));
                      return (
                        <li key={dispute.spanId} className="py-1.5">
                          <Link
                            href={buildCorrectionPagePath(catalogId, dispute.audioHash, dispute.spanId)}
                            className="block truncate hover:underline"
                          >
                            {item ? itemTitle(item) : dispute.audioHash.slice(0, 16)},{" "}
                            {formatClock(dispute.startSeconds)}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {t("action.objectedBy", { names: names.join(", ") })}
                            {dispute.since && ` · ${formatWhen(dispute.since, locale)}`}
                          </p>
                        </li>
                      );
                    })}
                    {data.disputes.total > ACTION_LIST_LIMIT && (
                      <li className="py-1.5 text-xs text-muted-foreground">
                        {t("action.more", { count: data.disputes.total - ACTION_LIST_LIMIT })}
                      </li>
                    )}
                  </ul>
                )}
              </ActionCard>

              <ActionCard title={t("action.status")}>
                {(
                  [
                    ["ready", t("action.ready")],
                    ["stale", t("action.stale")],
                    ["stalled", t("action.stalled", { days: STALLED_AFTER_DAYS })],
                  ] as const
                ).map(([kind, label]) => (
                  <Fragment key={kind}>
                    <p className="flex justify-between gap-3 font-medium">
                      <span>{label}</span>
                      <span className="tabular-nums">{view.action[kind].length}</span>
                    </p>
                    {view.action[kind].length > 0 && (
                      <RecordingLinks items={view.action[kind]} catalogId={catalogId} />
                    )}
                  </Fragment>
                ))}
              </ActionCard>
            </div>
          </section>
        </LoadedAtContext.Provider>
      )}
    </div>
  );
}
