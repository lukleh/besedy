"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMediumDate, formatPartialDate } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import { EventPlaybackProgress } from "./event-playback-progress";
import type {
  CatalogEventRow,
  EventSortKey,
  LocationItem,
  SortDirection,
} from "./event-list-types";

interface EventListResultsProps {
  catalogId: string;
  dateYearFilter: string;
  events: CatalogEventRow[];
  hasActiveFilters: boolean;
  locationFilter: string;
  locationOptions: LocationItem[];
  onDateYearFilterChange: (value: string) => void;
  onLocationFilterChange: (value: string) => void;
  onReleasedFilterChange: (value: "all" | "true" | "false") => void;
  onSort: (key: EventSortKey) => void;
  releasedFilter: "all" | "true" | "false";
  showAllColumns: boolean;
  showReleaseState: boolean;
  sortDir: SortDirection;
  sortKey: EventSortKey;
  yearOptions: number[];
}

export function EventListResults({
  catalogId,
  dateYearFilter,
  events,
  hasActiveFilters,
  locationFilter,
  locationOptions,
  onDateYearFilterChange,
  onLocationFilterChange,
  onReleasedFilterChange,
  onSort,
  releasedFilter,
  showAllColumns,
  showReleaseState,
  sortDir,
  sortKey,
  yearOptions,
}: EventListResultsProps) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("events.list");

  const getSortIcon = (key: EventSortKey) => {
    if (sortKey !== key) {
      return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />;
    }

    return sortDir === "asc"
      ? <ArrowUp className="h-3.5 w-3.5 text-foreground" />
      : <ArrowDown className="h-3.5 w-3.5 text-foreground" />;
  };

  const getSortAria = (key: EventSortKey): "ascending" | "descending" | "none" => {
    if (sortKey !== key) return "none";
    return sortDir === "asc" ? "ascending" : "descending";
  };

  const getPosterStatusLabel = (status: CatalogEventRow["posterStatus"]) => {
    if (status.portrait && status.landscape) return t("postersBoth");
    if (status.portrait) return t("postersPortrait");
    if (status.landscape) return t("postersLandscape");
    return t("postersMissing");
  };

  const getPosterStatusVariant = (
    status: CatalogEventRow["posterStatus"]
  ): "default" | "secondary" | "outline" => {
    if (status.portrait && status.landscape) return "default";
    if (status.portrait || status.landscape) return "secondary";
    return "outline";
  };

  const openEvent = (eventId: number) => {
    router.push(`/catalog/${catalogId}/event/${eventId}`);
  };

  return (
    <>
      <div className="hidden rounded-md border @[768px]/catalog:block landscape-mobile:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={getSortAria("date")}>
                <button
                  type="button"
                  className="inline-flex items-center gap-1"
                  onClick={() => onSort("date")}
                >
                  {t("columnDate")}
                  {getSortIcon("date")}
                </button>
              </TableHead>
              <TableHead aria-sort={getSortAria("location")}>
                <button
                  type="button"
                  className="inline-flex items-center gap-1"
                  onClick={() => onSort("location")}
                >
                  {t("columnLocation")}
                  {getSortIcon("location")}
                </button>
              </TableHead>
              {showAllColumns ? (
                <>
                  <TableHead aria-sort={getSortAria("recordingCount")} className="text-right">
                    <button
                      type="button"
                      className="inline-flex w-full items-center justify-end gap-1"
                      onClick={() => onSort("recordingCount")}
                    >
                      {t("columnRecordings")}
                      {getSortIcon("recordingCount")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">{t("columnSources")}</TableHead>
                  <TableHead>{t("columnPosters")}</TableHead>
                  <TableHead>{t("columnPrimaryRecording")}</TableHead>
                  <TableHead aria-sort={getSortAria("released")}>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                      onClick={() => onSort("released")}
                    >
                      {t("columnStatus")}
                      {getSortIcon("released")}
                    </button>
                  </TableHead>
                </>
              ) : null}
            </TableRow>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="py-1.5 font-normal">
                <select
                  value={dateYearFilter}
                  onChange={(event) => onDateYearFilterChange(event.target.value)}
                  className={cn(
                    "h-7 w-full rounded-md border border-input bg-background px-2 text-xs",
                    dateYearFilter !== "all" && "border-primary"
                  )}
                  aria-label={t("dateYearFilterAria")}
                >
                  <option value="all">{t("allYears")}</option>
                  {yearOptions.map((year) => (
                    <option key={year} value={year.toString()}>
                      {year}
                    </option>
                  ))}
                </select>
              </TableHead>
              <TableHead className="py-1.5 font-normal">
                <div className={cn("space-y-1", showReleaseState && !showAllColumns && "min-w-[12rem]")}>
                  <select
                    value={locationFilter}
                    onChange={(event) => onLocationFilterChange(event.target.value)}
                    className={cn(
                      "h-7 w-full rounded-md border border-input bg-background px-2 text-xs",
                      locationFilter !== "all" && "border-primary"
                    )}
                    aria-label={t("locationFilterAria")}
                  >
                    <option value="all">{t("allLocations")}</option>
                    {locationOptions.map((location) => (
                      <option key={location.id} value={location.id.toString()}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                  {showReleaseState && !showAllColumns ? (
                    <select
                      value={releasedFilter}
                      onChange={(event) =>
                        onReleasedFilterChange(event.target.value as "all" | "true" | "false")
                      }
                      className={cn(
                        "h-7 w-full rounded-md border border-input bg-background px-2 text-xs",
                        releasedFilter !== "all" && "border-primary"
                      )}
                      aria-label={t("statusFilterAria")}
                    >
                      <option value="all">{t("all")}</option>
                      <option value="true">{t("released")}</option>
                      <option value="false">{t("unreleased")}</option>
                    </select>
                  ) : null}
                </div>
              </TableHead>
              {showAllColumns ? (
                <>
                  <TableHead className="py-1.5 font-normal text-right" />
                  <TableHead className="py-1.5 font-normal text-right" />
                  <TableHead className="py-1.5 font-normal" />
                  <TableHead className="py-1.5 font-normal" />
                  <TableHead className="py-1.5 font-normal">
                    <select
                      value={releasedFilter}
                      onChange={(event) =>
                        onReleasedFilterChange(event.target.value as "all" | "true" | "false")
                      }
                      className={cn(
                        "h-7 w-full rounded-md border border-input bg-background px-2 text-xs",
                        releasedFilter !== "all" && "border-primary"
                      )}
                      aria-label={t("statusFilterAria")}
                    >
                      <option value="all">{t("all")}</option>
                      <option value="true">{t("released")}</option>
                      <option value="false">{t("unreleased")}</option>
                    </select>
                  </TableHead>
                </>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={showAllColumns ? 7 : 2}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {hasActiveFilters ? t("noMatch") : t("empty")}
                </TableCell>
              </TableRow>
            ) : (
              events.map((catalogEvent) => {
                const formattedDate =
                  formatPartialDate(
                    catalogEvent.dateYear,
                    catalogEvent.dateMonth,
                    catalogEvent.dateDay,
                    locale
                  ) ?? String(catalogEvent.dateYear);

                return (
                  <TableRow
                    key={catalogEvent.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => openEvent(catalogEvent.id)}
                  >
                    <TableCell>
                      <div className="font-semibold">{formattedDate}</div>
                      {catalogEvent.sessionIndex > 1 ? (
                        <Badge variant="outline" className="mt-1">
                          {t("sessionLabel", { index: catalogEvent.sessionIndex })}
                        </Badge>
                      ) : null}
                      <EventPlaybackProgress
                        playback={catalogEvent.playback}
                        className="mt-1"
                        showLabel
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <div>{catalogEvent.location?.name ?? t("unknownLocation")}</div>
                      {showReleaseState && !showAllColumns ? (
                        <div className="mt-1">
                          {catalogEvent.released ? (
                            <Badge>{t("released")}</Badge>
                          ) : (
                            <Badge variant="secondary">{t("unreleased")}</Badge>
                          )}
                        </div>
                      ) : null}
                    </TableCell>
                    {showAllColumns ? (
                      <>
                        <TableCell className="text-right">{catalogEvent.recordingCount}</TableCell>
                        <TableCell className="text-right">{catalogEvent.sourceCount}</TableCell>
                        <TableCell>
                          <Badge variant={getPosterStatusVariant(catalogEvent.posterStatus)}>
                            {getPosterStatusLabel(catalogEvent.posterStatus)}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[320px] truncate">
                          {catalogEvent.primaryTitle ?? t("missingPrimary")}
                        </TableCell>
                        <TableCell>
                          {catalogEvent.released ? (
                            <Badge>{t("released")}</Badge>
                          ) : (
                            <Badge variant="secondary">{t("unreleased")}</Badge>
                          )}
                        </TableCell>
                      </>
                    ) : null}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-2 @[768px]/catalog:hidden landscape-mobile:block">
        {events.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            {hasActiveFilters ? t("noMatch") : t("empty")}
          </div>
        ) : (
          events.map((catalogEvent) => {
            const month = catalogEvent.dateMonth;
            const day = catalogEvent.dateDay;
            const formattedDate =
              month !== null && day !== null
              ? formatMediumDate(
                  catalogEvent.dateYear,
                  month,
                  day,
                  locale
                )
              : formatPartialDate(
                  catalogEvent.dateYear,
                  month,
                  day,
                  locale
                ) || String(catalogEvent.dateYear);
            const locationName =
              catalogEvent.location?.name ?? t("unknownLocation");

            return (
              <button
                key={catalogEvent.id}
                type="button"
                data-testid={`event-card-${catalogEvent.id}`}
                className={cn(
                  "bg-card text-card-foreground flex w-full rounded-xl border py-0 text-left shadow-sm",
                  "hover:bg-muted/50 active:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                )}
                onClick={() => openEvent(catalogEvent.id)}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="min-h-14 @[400px]:min-h-0">
                      <div className="text-lg leading-7 font-semibold">
                        <span className="block truncate @[400px]:inline">
                          {formattedDate}
                        </span>
                        <span className="hidden @[400px]:inline"> · </span>
                        <span className="block truncate @[400px]:inline">
                          {locationName}
                        </span>
                      </div>
                      {catalogEvent.sessionIndex > 1 ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t("sessionLabel", { index: catalogEvent.sessionIndex })}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <EventPlaybackProgress playback={catalogEvent.playback} />
                </div>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
