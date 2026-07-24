"use client";

import { useLocale, useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ResizeHandle } from "@/components/catalog/resize-handle";
import { getMonthName } from "@/lib/date-format";
import type { UseColumnResizeReturn } from "@/hooks/use-column-resize";
import type { ColumnKey } from "../types";
import type { UseCatalogFiltersReturn } from "../hooks/use-catalog-filters";

type CountedValueOption<T> = { value: T; count: number };
type CountedNamedOption = { id: number; name: string; count: number };

interface DesktopCatalogTableHeaderProps {
  albums: CountedNamedOption[];
  artists: CountedValueOption<string>[];
  availableDurations: CountedValueOption<"short" | "medium" | "long">[];
  availableMonths: CountedValueOption<number>[];
  availableParts: CountedValueOption<number>[];
  availableStatuses: CountedValueOption<"ready" | "incomplete">[];
  availableVerified: CountedValueOption<boolean>[];
  availableYears: CountedValueOption<number>[];
  columnResize: UseColumnResizeReturn;
  columnVisibility: Record<ColumnKey, boolean>;
  duplicateCounts: CountedValueOption<number>[];
  filters: UseCatalogFiltersReturn;
  hasDuplicateCounts: boolean;
  hasDurations: boolean;
  hasStatuses: boolean;
  hasVerifiedOptions: boolean;
  lastVisibleColumnKey?: ColumnKey;
  locations: CountedNamedOption[];
  recorders: CountedNamedOption[];
}

export function DesktopCatalogTableHeader({
  albums,
  artists,
  availableDurations,
  availableMonths,
  availableParts,
  availableStatuses,
  availableVerified,
  availableYears,
  columnResize,
  columnVisibility,
  duplicateCounts,
  filters,
  hasDuplicateCounts,
  hasDurations,
  hasStatuses,
  hasVerifiedOptions,
  lastVisibleColumnKey,
  locations,
  recorders,
}: DesktopCatalogTableHeaderProps) {
  const locale = useLocale();
  const t = useTranslations("catalog");
  const tFilters = useTranslations("catalog.filters");

  const renderSortIcon = (key: ColumnKey) => {
    if (filters.sortKey !== key) {
      return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />;
    }

    return filters.sortDir === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5 text-foreground" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5 text-foreground" />
    );
  };

  const getSortAria = (
    key: ColumnKey
  ): "none" | "ascending" | "descending" => {
    if (filters.sortKey !== key) return "none";
    return filters.sortDir === "asc" ? "ascending" : "descending";
  };

  const colVis = columnVisibility;

  return (
    <TableHeader>
      <TableRow>
        {colVis.title && (
          <TableHead
            style={columnResize.getColumnStyle("title")}
            aria-sort={getSortAria("title")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("title")}
            >
              {t("columns.titleFilename")}
              {renderSortIcon("title")}
            </button>
            {lastVisibleColumnKey !== "title" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("title", x, element)
                }
                isResizing={columnResize.resizingColumn === "title"}
              />
            )}
          </TableHead>
        )}
        {colVis.date && (
          <TableHead
            style={columnResize.getColumnStyle("date")}
            aria-sort={getSortAria("date")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("date")}
            >
              {t("columns.date")}
              {renderSortIcon("date")}
            </button>
            {lastVisibleColumnKey !== "date" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("date", x, element)
                }
                isResizing={columnResize.resizingColumn === "date"}
              />
            )}
          </TableHead>
        )}
        {colVis.part && (
          <TableHead
            style={columnResize.getColumnStyle("part")}
            aria-sort={getSortAria("part")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("part")}
            >
              {t("columns.part")}
              {renderSortIcon("part")}
            </button>
            {lastVisibleColumnKey !== "part" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("part", x, element)
                }
                isResizing={columnResize.resizingColumn === "part"}
              />
            )}
          </TableHead>
        )}
        {colVis.recorder && (
          <TableHead
            style={columnResize.getColumnStyle("recorder")}
            aria-sort={getSortAria("recorder")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("recorder")}
            >
              {t("columns.recorder")}
              {renderSortIcon("recorder")}
            </button>
            {lastVisibleColumnKey !== "recorder" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("recorder", x, element)
                }
                isResizing={columnResize.resizingColumn === "recorder"}
              />
            )}
          </TableHead>
        )}
        {colVis.location && (
          <TableHead
            style={columnResize.getColumnStyle("location")}
            aria-sort={getSortAria("location")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("location")}
            >
              {t("columns.location")}
              {renderSortIcon("location")}
            </button>
            {lastVisibleColumnKey !== "location" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("location", x, element)
                }
                isResizing={columnResize.resizingColumn === "location"}
              />
            )}
          </TableHead>
        )}
        {colVis.duration && (
          <TableHead
            style={columnResize.getColumnStyle("duration")}
            aria-sort={getSortAria("duration")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("duration")}
            >
              {t("columns.duration")}
              {renderSortIcon("duration")}
            </button>
            {lastVisibleColumnKey !== "duration" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("duration", x, element)
                }
                isResizing={columnResize.resizingColumn === "duration"}
              />
            )}
          </TableHead>
        )}
        {colVis.artist && (
          <TableHead
            style={columnResize.getColumnStyle("artist")}
            aria-sort={getSortAria("artist")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("artist")}
            >
              {t("columns.artist")}
              {renderSortIcon("artist")}
            </button>
            {lastVisibleColumnKey !== "artist" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("artist", x, element)
                }
                isResizing={columnResize.resizingColumn === "artist"}
              />
            )}
          </TableHead>
        )}
        {colVis.album && (
          <TableHead
            style={columnResize.getColumnStyle("album")}
            aria-sort={getSortAria("album")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("album")}
            >
              {t("columns.album")}
              {renderSortIcon("album")}
            </button>
            {lastVisibleColumnKey !== "album" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("album", x, element)
                }
                isResizing={columnResize.resizingColumn === "album"}
              />
            )}
          </TableHead>
        )}
        {colVis.status && (
          <TableHead
            style={columnResize.getColumnStyle("status")}
            aria-sort={getSortAria("status")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("status")}
            >
              {t("columns.status")}
              {renderSortIcon("status")}
            </button>
            {lastVisibleColumnKey !== "status" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("status", x, element)
                }
                isResizing={columnResize.resizingColumn === "status"}
              />
            )}
          </TableHead>
        )}
        {colVis.verified && (
          <TableHead
            style={columnResize.getColumnStyle("verified")}
            aria-sort={getSortAria("verified")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("verified")}
            >
              {t("columns.verified")}
              {renderSortIcon("verified")}
            </button>
            {lastVisibleColumnKey !== "verified" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("verified", x, element)
                }
                isResizing={columnResize.resizingColumn === "verified"}
              />
            )}
          </TableHead>
        )}
        {colVis.duplicates && (
          <TableHead
            style={columnResize.getColumnStyle("duplicates")}
            aria-sort={getSortAria("duplicates")}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onClick={() => filters.handleSort("duplicates")}
            >
              {t("columns.duplicates")}
              {renderSortIcon("duplicates")}
            </button>
            {lastVisibleColumnKey !== "duplicates" && (
              <ResizeHandle
                onResizeStart={(x, element) =>
                  columnResize.startResize("duplicates", x, element)
                }
                isResizing={columnResize.resizingColumn === "duplicates"}
              />
            )}
          </TableHead>
        )}
        {colVis.offline && (
          <TableHead className="w-12 text-center">{t("columns.offline")}</TableHead>
        )}
      </TableRow>

      <TableRow className="bg-muted/30 hover:bg-muted/30">
        {colVis.title && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("title")}
          />
        )}
        {colVis.date && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("date")}
          >
            <div className="flex items-center gap-1">
              <Select
                value={filters.dateYear}
                onValueChange={filters.handleDateYearChange}
              >
                <SelectTrigger
                  className={cn(
                    "h-7 text-xs",
                    filters.dateYear === "all" ? "w-full" : "w-[80px] border-primary"
                  )}
                  aria-label={t("columns.date")}
                >
                  <SelectValue placeholder={tFilters("dateYear")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tFilters("allYears")}</SelectItem>
                  {availableYears.map((year) => (
                    <SelectItem
                      key={year.value}
                      value={year.value.toString()}
                    >
                      {year.value}
                    </SelectItem>
                  ))}
                  <SelectItem value="empty">{tFilters("empty")}</SelectItem>
                </SelectContent>
              </Select>

              {filters.dateYear !== "all" && filters.dateYear !== "empty" && (
                <Select
                  value={filters.dateMonth}
                  onValueChange={filters.handleDateMonthChange}
                  disabled={!availableMonths.length}
                >
                  <SelectTrigger
                    className={cn(
                      "h-7 w-[110px] text-xs",
                      filters.dateMonth !== "all" && "border-primary"
                    )}
                    aria-label={tFilters("dateMonth")}
                  >
                    <SelectValue placeholder="MM" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{tFilters("allMonths")}</SelectItem>
                    {availableMonths.map((month) => (
                      <SelectItem
                        key={month.value}
                        value={month.value.toString()}
                      >
                        {getMonthName(month.value, locale)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </TableHead>
        )}
        {colVis.part && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("part")}
          >
            <Select value={filters.partFilter} onValueChange={filters.setPartFilter}>
              <SelectTrigger
                className={cn(
                  "h-7 w-full text-xs",
                  filters.partFilter !== "all" && "border-primary"
                )}
                aria-label={t("columns.part")}
              >
                <SelectValue placeholder={tFilters("allParts")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tFilters("allParts")}</SelectItem>
                {availableParts.map((part) => (
                  <SelectItem key={part.value} value={part.value.toString()}>
                    {part.value}
                  </SelectItem>
                ))}
                <SelectItem value="empty">{tFilters("empty")}</SelectItem>
              </SelectContent>
            </Select>
          </TableHead>
        )}
        {colVis.recorder && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("recorder")}
          >
            <Select
              value={filters.recorderFilter}
              onValueChange={filters.setRecorderFilter}
            >
              <SelectTrigger
                className={cn(
                  "h-7 w-full text-xs",
                  filters.recorderFilter !== "all" && "border-primary"
                )}
                aria-label={t("columns.recorder")}
              >
                <SelectValue placeholder={tFilters("allRecorders")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tFilters("allRecorders")}</SelectItem>
                {recorders.map((recorder) => (
                  <SelectItem
                    key={recorder.id}
                    value={recorder.id.toString()}
                  >
                    {recorder.name}
                  </SelectItem>
                ))}
                <SelectItem value="empty">{tFilters("empty")}</SelectItem>
              </SelectContent>
            </Select>
          </TableHead>
        )}
        {colVis.location && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("location")}
          >
            <Select
              value={filters.locationFilter}
              onValueChange={filters.setLocationFilter}
            >
              <SelectTrigger
                className={cn(
                  "h-7 w-full text-xs",
                  filters.locationFilter !== "all" && "border-primary"
                )}
                aria-label={t("columns.location")}
              >
                <SelectValue placeholder={tFilters("allLocations")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tFilters("allLocations")}</SelectItem>
                {locations.map((location) => (
                  <SelectItem
                    key={location.id}
                    value={location.id.toString()}
                  >
                    {location.name}
                  </SelectItem>
                ))}
                <SelectItem value="empty">{tFilters("empty")}</SelectItem>
              </SelectContent>
            </Select>
          </TableHead>
        )}
        {colVis.duration && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("duration")}
          >
            <Select
              value={filters.durationFilter}
              onValueChange={filters.setDurationFilter}
              disabled={!hasDurations}
            >
              <SelectTrigger
                className={cn(
                  "h-7 w-full text-xs",
                  filters.durationFilter !== "all" && "border-primary"
                )}
                aria-label={t("columns.duration")}
              >
                <SelectValue placeholder={t("duration.all")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("duration.all")}</SelectItem>
                {availableDurations.map((duration) => (
                  <SelectItem key={duration.value} value={duration.value}>
                    {t(`duration.${duration.value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TableHead>
        )}
        {colVis.artist && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("artist")}
          >
            <Select
              value={filters.artistFilter}
              onValueChange={filters.setArtistFilter}
            >
              <SelectTrigger
                className={cn(
                  "h-7 w-full text-xs",
                  filters.artistFilter !== "all" && "border-primary"
                )}
                aria-label={t("columns.artist")}
              >
                <SelectValue placeholder={tFilters("allArtists")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tFilters("allArtists")}</SelectItem>
                {artists.map((artist) => (
                  <SelectItem key={artist.value} value={artist.value}>
                    {artist.value}
                  </SelectItem>
                ))}
                <SelectItem value="empty">{tFilters("empty")}</SelectItem>
              </SelectContent>
            </Select>
          </TableHead>
        )}
        {colVis.album && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("album")}
          >
            <Select value={filters.albumFilter} onValueChange={filters.setAlbumFilter}>
              <SelectTrigger
                className={cn(
                  "h-7 w-full text-xs",
                  filters.albumFilter !== "all" && "border-primary"
                )}
                aria-label={t("columns.album")}
              >
                <SelectValue placeholder={tFilters("allAlbums")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tFilters("allAlbums")}</SelectItem>
                {albums.map((album) => (
                  <SelectItem key={album.id} value={album.id.toString()}>
                    {album.name}
                  </SelectItem>
                ))}
                <SelectItem value="empty">{tFilters("empty")}</SelectItem>
              </SelectContent>
            </Select>
          </TableHead>
        )}
        {colVis.status && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("status")}
          >
            <Select
              value={filters.statusFilter}
              onValueChange={filters.setStatusFilter}
              disabled={!hasStatuses}
            >
              <SelectTrigger
                className={cn(
                  "h-7 w-full text-xs",
                  filters.statusFilter !== "all" && "border-primary"
                )}
                aria-label={t("columns.status")}
              >
                <SelectValue placeholder={t("status.all")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("status.all")}</SelectItem>
                {availableStatuses.map((status) => (
                  <SelectItem key={status.value} value={status.value}>
                    {status.value === "ready"
                      ? t("status.published")
                      : t("status.incomplete")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TableHead>
        )}
        {colVis.verified && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("verified")}
          >
            <Select
              value={filters.verifiedFilter}
              onValueChange={filters.setVerifiedFilter}
              disabled={!hasVerifiedOptions}
            >
              <SelectTrigger
                className={cn(
                  "h-7 w-full text-xs",
                  filters.verifiedFilter !== "all" && "border-primary"
                )}
                aria-label={t("columns.verified")}
              >
                <SelectValue placeholder={t("verifiedFilter.all")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("verifiedFilter.all")}</SelectItem>
                {availableVerified.map((value) => (
                  <SelectItem
                    key={String(value.value)}
                    value={value.value ? "verified" : "unverified"}
                  >
                    {t(
                      `verifiedFilter.${value.value ? "verified" : "unverified"}`
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TableHead>
        )}
        {colVis.duplicates && (
          <TableHead
            className="py-1.5 font-normal"
            style={columnResize.getColumnStyle("duplicates")}
          >
            <Select
              value={filters.duplicatesFilter}
              onValueChange={filters.setDuplicatesFilter}
              disabled={!hasDuplicateCounts}
            >
              <SelectTrigger
                className={cn(
                  "h-7 w-full text-xs",
                  filters.duplicatesFilter !== "all" && "border-primary"
                )}
                aria-label={t("columns.duplicates")}
              >
                <SelectValue placeholder={tFilters("allDuplicates")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tFilters("allDuplicates")}</SelectItem>
                {duplicateCounts.map((duplicate) => (
                  <SelectItem
                    key={duplicate.value}
                    value={duplicate.value.toString()}
                  >
                    {duplicate.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TableHead>
        )}
        {colVis.offline && <TableHead className="py-1.5 w-12" />}
      </TableRow>
    </TableHeader>
  );
}
