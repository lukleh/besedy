"use client";

import type { CatalogRole } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";
import {
  BookOpen,
  Headphones,
  Mic2,
  Pencil,
  ShieldCheck,
  UserCheck,
  UserX,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";

interface CatalogSettingsAccessSummaryProps {
  roleFilter: CatalogRole | "all" | "revoked";
  countByRole: (role: CatalogRole) => number;
  onRoleFilterChange: (value: CatalogRole | "all" | "revoked") => void;
  totalActiveUsers: number;
  totalRevokedUsers: number;
}

export function CatalogSettingsAccessSummary({
  roleFilter,
  countByRole,
  onRoleFilterChange,
  totalActiveUsers,
  totalRevokedUsers,
}: CatalogSettingsAccessSummaryProps) {
  const t = useTranslations("catalogSettings");

  const cards = [
    {
      id: "all" as const,
      count: totalActiveUsers,
      icon: Users,
      label: t("stats.totalUsers"),
      color: "primary",
    },
    {
      id: "catalog_admin" as const,
      count: countByRole("catalog_admin"),
      icon: ShieldCheck,
      label: t("stats.catalogAdmins"),
      color: "emerald",
    },
    {
      id: "curator" as const,
      count: countByRole("curator"),
      icon: UserCheck,
      label: t("stats.curators"),
      color: "amber",
    },
    {
      id: "host" as const,
      count: countByRole("host"),
      icon: Mic2,
      label: t("stats.hosts"),
      color: "violet",
    },
    {
      id: "corrector" as const,
      count: countByRole("corrector"),
      icon: Pencil,
      label: t("stats.correctors"),
      color: "blue",
    },
    {
      id: "reader" as const,
      count: countByRole("reader"),
      icon: BookOpen,
      label: t("stats.readers"),
      color: "gray",
    },
    {
      id: "listener" as const,
      count: countByRole("listener"),
      icon: Headphones,
      label: t("stats.listeners"),
      color: "slate",
    },
    {
      id: "revoked" as const,
      count: totalRevokedUsers,
      icon: UserX,
      label: t("stats.withoutAccess"),
      color: "red",
    },
  ];

  const buttonColorClasses: Record<string, string> = {
    primary: "hover:border-primary/50 data-[active=true]:ring-primary",
    emerald: "hover:border-emerald-500/50 data-[active=true]:ring-emerald-500",
    amber: "hover:border-amber-500/50 data-[active=true]:ring-amber-500",
    violet: "hover:border-violet-500/50 data-[active=true]:ring-violet-500",
    blue: "hover:border-blue-500/50 data-[active=true]:ring-blue-500",
    gray: "hover:border-gray-500/50 data-[active=true]:ring-gray-500",
    slate: "hover:border-slate-500/50 data-[active=true]:ring-slate-500",
    red: "hover:border-red-500/50 data-[active=true]:ring-red-500",
  };
  const iconColorClasses: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    emerald:
      "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/50 dark:text-emerald-400",
    amber:
      "bg-amber-100 text-amber-600 dark:bg-amber-900/50 dark:text-amber-400",
    violet:
      "bg-violet-100 text-violet-600 dark:bg-violet-900/50 dark:text-violet-400",
    blue: "bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400",
    gray: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    slate: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
    red: "bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-400",
  };

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <button
            key={card.id}
            type="button"
            data-active={roleFilter === card.id}
            onClick={() => onRoleFilterChange(card.id)}
            className={cn(
              "flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all data-[active=true]:ring-2 data-[active=true]:ring-offset-2",
              buttonColorClasses[card.color]
            )}
          >
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                iconColorClasses[card.color]
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xl font-bold text-foreground">
                {card.count}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {card.label}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
