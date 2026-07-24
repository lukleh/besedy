"use client";

import { AccessLevel } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";
import {
  Crown,
  Eye,
  Headphones,
  Pencil,
  User,
  UserX,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";

interface CatalogSettingsAccessSummaryProps {
  accessLevelFilter: AccessLevel | "all" | "revoked";
  countByLevel: (level: AccessLevel) => number;
  onAccessLevelFilterChange: (value: AccessLevel | "all" | "revoked") => void;
  totalActiveUsers: number;
  totalRevokedUsers: number;
}

export function CatalogSettingsAccessSummary({
  accessLevelFilter,
  countByLevel,
  onAccessLevelFilterChange,
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
      activeClassName: "ring-primary",
      iconClassName: "bg-primary/10 text-primary",
      hoverClassName: "hover:border-primary/50",
    },
    {
      id: "OWNER" as const,
      count: countByLevel(AccessLevel.OWNER),
      icon: Crown,
      label: t("stats.owners"),
      activeClassName: "ring-emerald-500",
      iconClassName: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/50 dark:text-emerald-400",
      hoverClassName: "hover:border-emerald-500/50",
    },
    {
      id: "EDITOR" as const,
      count: countByLevel(AccessLevel.EDITOR),
      icon: Pencil,
      label: t("stats.editors"),
      activeClassName: "ring-amber-500",
      iconClassName: "bg-amber-100 text-amber-600 dark:bg-amber-900/50 dark:text-amber-400",
      hoverClassName: "hover:border-amber-500/50",
    },
    {
      id: "MEMBER" as const,
      count: countByLevel(AccessLevel.MEMBER),
      icon: User,
      label: t("stats.members"),
      activeClassName: "ring-blue-500",
      iconClassName: "bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400",
      hoverClassName: "hover:border-blue-500/50",
    },
    {
      id: "VIEWER" as const,
      count: countByLevel(AccessLevel.VIEWER),
      icon: Eye,
      label: t("stats.viewers"),
      activeClassName: "ring-gray-500",
      iconClassName: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
      hoverClassName: "hover:border-gray-500/50",
    },
    {
      id: "LISTENER" as const,
      count: countByLevel(AccessLevel.LISTENER),
      icon: Headphones,
      label: t("stats.listeners"),
      activeClassName: "ring-slate-500",
      iconClassName: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
      hoverClassName: "hover:border-slate-500/50",
    },
    {
      id: "revoked" as const,
      count: totalRevokedUsers,
      icon: UserX,
      label: t("stats.withoutAccess"),
      activeClassName: "ring-red-500",
      iconClassName: "bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-400",
      hoverClassName: "hover:border-red-500/50",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {cards.map((card) => {
        const Icon = card.icon;

        return (
          <button
            key={card.id}
            type="button"
            onClick={() => onAccessLevelFilterChange(card.id)}
            className={cn(
              "flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all",
              card.hoverClassName,
              accessLevelFilter === card.id && `ring-2 ring-offset-2 ${card.activeClassName}`
            )}
          >
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                card.iconClassName
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xl font-bold">{card.count}</div>
              <div className="truncate text-xs text-muted-foreground">{card.label}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
