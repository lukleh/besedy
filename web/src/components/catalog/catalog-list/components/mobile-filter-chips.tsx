"use client";

import { useTranslations } from "next-intl";
import { Calendar, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import { cn } from "@/lib/utils";
import type { FilterOptionsResponse } from "@/hooks/use-filter-options";

interface MobileFilterChipsProps {
  dateYear: string;
  handleDateYearChange: (value: string) => void;
  locationFilter: string;
  setLocationFilter: (value: string) => void;
  filterOptions: FilterOptionsResponse | undefined;
  hasActiveFilters: boolean;
  clearFilters: () => void;
}

export function MobileFilterChips({
  dateYear,
  handleDateYearChange,
  locationFilter,
  setLocationFilter,
  filterOptions,
  hasActiveFilters,
  clearFilters,
}: MobileFilterChipsProps) {
  const t = useTranslations("catalog");
  const tFilters = useTranslations("catalog.filters");

  const availableYears = filterOptions?.options.years ?? [];
  const locations = filterOptions?.options.locations ?? [];

  const dateChipLabel =
    dateYear === "all"
      ? tFilters("dateYear")
      : dateYear === "empty"
        ? tFilters("empty")
        : dateYear;

  const locationChipLabel =
    locationFilter === "all"
      ? tFilters("location")
      : locationFilter === "empty"
        ? tFilters("empty")
        : locations.find((location) => location.id.toString() === locationFilter)?.name ??
          tFilters("location");

  return (
    <div className="@[768px]/catalog:hidden landscape-mobile:block" data-testid="mobile-filter-chips">
      <div className="flex min-w-0 items-center gap-2 pb-1">
        <div className="shrink-0">
          <ResponsiveSelect value={dateYear} onValueChange={handleDateYearChange}>
            <ResponsiveSelectTrigger
              className={cn(
                "h-8 rounded-full px-3 text-xs",
                dateYear !== "all" && "border-primary"
              )}
              aria-label={t("columns.date")}
            >
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                <ResponsiveSelectValue placeholder={tFilters("dateYear")} displayValue={dateChipLabel} />
              </span>
            </ResponsiveSelectTrigger>
            <ResponsiveSelectContent title={t("columns.date")}>
              <ResponsiveSelectItem value="all">{tFilters("allYears")}</ResponsiveSelectItem>
              {availableYears.map((year) => (
                <ResponsiveSelectItem key={year.value} value={year.value.toString()}>
                  {year.value}
                </ResponsiveSelectItem>
              ))}
              <ResponsiveSelectItem value="empty">{tFilters("empty")}</ResponsiveSelectItem>
            </ResponsiveSelectContent>
          </ResponsiveSelect>
        </div>

        <div className="min-w-0 flex-1">
          <ResponsiveSelect value={locationFilter} onValueChange={setLocationFilter}>
            <ResponsiveSelectTrigger
              className={cn(
                "h-8 w-full min-w-0 rounded-full px-3 text-xs",
                locationFilter !== "all" && "border-primary"
              )}
              aria-label={t("columns.location")}
            >
              <span className="inline-flex min-w-0 items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="min-w-0 flex-1">
                  <ResponsiveSelectValue
                    placeholder={tFilters("location")}
                    displayValue={locationChipLabel}
                  />
                </span>
              </span>
            </ResponsiveSelectTrigger>
            <ResponsiveSelectContent title={t("columns.location")}>
              <ResponsiveSelectItem value="all">{tFilters("allLocations")}</ResponsiveSelectItem>
              {locations.map((location) => (
                <ResponsiveSelectItem key={location.id} value={location.id.toString()}>
                  {location.name}
                </ResponsiveSelectItem>
              ))}
              <ResponsiveSelectItem value="empty">{tFilters("empty")}</ResponsiveSelectItem>
            </ResponsiveSelectContent>
          </ResponsiveSelect>
        </div>

        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn(
            "h-8 w-8 shrink-0 rounded-full",
            !hasActiveFilters && "pointer-events-none invisible"
          )}
          onClick={() => {
            if (hasActiveFilters) clearFilters();
          }}
          aria-label={t("clearFilters")}
          aria-hidden={!hasActiveFilters}
          tabIndex={hasActiveFilters ? 0 : -1}
          disabled={!hasActiveFilters}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
