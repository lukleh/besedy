"use client";

import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import type { Stats } from "./users-content-types";

interface UsersStatsCardsProps {
  onFilterChange: (value: string) => void;
  stats?: Stats;
  statusFilter: string;
}

interface UsersFiltersProps {
  onClearSearch: () => void;
  onFilterChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  search: string;
  statusFilter: string;
}

/**
 * Owns the compact overview and filtering controls for the admin users page.
 */
export function UsersStatsCards({
  onFilterChange,
  stats,
  statusFilter,
}: UsersStatsCardsProps) {
  const t = useTranslations("admin");

  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Card
        className={`cursor-pointer transition-all hover:border-primary/50 ${
          statusFilter === "all" ? "ring-2 ring-primary ring-offset-2" : ""
        }`}
        onClick={() => onFilterChange("all")}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t("users.stats.totalUsers")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats?.total ?? 0}</div>
        </CardContent>
      </Card>
      <Card
        className={`cursor-pointer transition-all hover:border-primary/50 ${
          statusFilter === "ACTIVE" ? "ring-2 ring-green-600 ring-offset-2" : ""
        }`}
        onClick={() => onFilterChange("ACTIVE")}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t("users.stats.active")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-green-600">
            {stats?.active ?? 0}
          </div>
        </CardContent>
      </Card>
      <Card
        className={`cursor-pointer transition-all hover:border-primary/50 ${
          statusFilter === "PENDING" ? "ring-2 ring-yellow-600 ring-offset-2" : ""
        }`}
        onClick={() => onFilterChange("PENDING")}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t("users.stats.pending")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-yellow-700">
            {stats?.pending ?? 0}
          </div>
        </CardContent>
      </Card>
      <Card
        className={`cursor-pointer transition-all hover:border-primary/50 ${
          statusFilter === "BLOCKED" ? "ring-2 ring-red-600 ring-offset-2" : ""
        }`}
        onClick={() => onFilterChange("BLOCKED")}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t("users.stats.blocked")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-red-600">
            {stats?.blocked ?? 0}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function UsersFilters({
  onClearSearch,
  onFilterChange,
  onSearchChange,
  search,
  statusFilter,
}: UsersFiltersProps) {
  const t = useTranslations("admin");

  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("users.search.placeholder")}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9 pr-9"
        />
        {search && (
          <button
            type="button"
            onClick={onClearSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={t("users.search.clear")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <ResponsiveSelect value={statusFilter} onValueChange={onFilterChange}>
        <ResponsiveSelectTrigger
          className="w-full sm:w-[180px]"
          aria-label={t("users.search.filterByStatus")}
        >
          <ResponsiveSelectValue
            placeholder={t("users.search.filterByStatus")}
            displayValue={
              statusFilter !== "all"
                ? t(`users.status.${statusFilter.toLowerCase()}`)
                : undefined
            }
          />
        </ResponsiveSelectTrigger>
        <ResponsiveSelectContent title={t("users.search.filterByStatus")}>
          <ResponsiveSelectItem value="all">
            {t("users.search.allStatuses")}
          </ResponsiveSelectItem>
          <ResponsiveSelectItem value="ACTIVE">
            {t("users.status.active")}
          </ResponsiveSelectItem>
          <ResponsiveSelectItem value="PENDING">
            {t("users.status.pending")}
          </ResponsiveSelectItem>
          <ResponsiveSelectItem value="BLOCKED">
            {t("users.status.blocked")}
          </ResponsiveSelectItem>
        </ResponsiveSelectContent>
      </ResponsiveSelect>
    </div>
  );
}
