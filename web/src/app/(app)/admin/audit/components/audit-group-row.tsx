"use client";

import { useTranslations } from "next-intl";
import { ChevronRight, ChevronDown } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { AuditLogGroup } from "../types";
import {
  formatDomainLabel,
  formatActionLabel,
  formatTimestampRange,
  formatUserAgent,
  getActionBadgeVariant,
  getOutcomeBadgeVariant,
} from "../utils";
import { ExpandedAuditRow } from "./expanded-audit-row";

interface AuditGroupRowProps {
  group: AuditLogGroup;
  isExpanded: boolean;
  onToggle: () => void;
}

export function AuditGroupRow({
  group,
  isExpanded,
  onToggle,
}: AuditGroupRowProps) {
  const t = useTranslations("admin.audit");
  const isSingleEntry = group.entries.length === 1;

  // Single entry - render as regular row (no expansion)
  if (isSingleEntry) {
    const log = group.entries[0];
    return (
      <TableRow className="hover:bg-muted/50">
        <TableCell className="font-mono text-xs">
          {new Date(log.createdAt).toISOString().replace("T", " ").slice(0, 19)}
        </TableCell>
        <TableCell>
          <div className="space-y-1">
            <div title={log.actor.secondaryLabel || undefined}>
              {log.actor.label || t("system")}
            </div>
            {log.actor.secondaryLabel && (
              <div className="text-xs text-muted-foreground">
                {log.actor.secondaryLabel}
              </div>
            )}
          </div>
        </TableCell>
        <TableCell>
          <div className="space-y-2">
            <div className="font-medium leading-snug">{log.summary}</div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={getActionBadgeVariant(log.action)}>
                {formatActionLabel(log.action)}
              </Badge>
              <Badge variant={getOutcomeBadgeVariant(log.outcome)}>
                {log.outcome}
              </Badge>
              <Badge variant="outline">{formatDomainLabel(log.domain)}</Badge>
            </div>
          </div>
        </TableCell>
        <TableCell className="hidden md:table-cell landscape-mobile:hidden">
          <div className="space-y-1">
            <div>{log.target?.label || log.resource}</div>
            {log.target?.secondaryLabel && (
              <div className="text-xs text-muted-foreground">
                {log.target.secondaryLabel}
              </div>
            )}
            {log.target?.catalogLabel && (
              <div className="text-xs text-muted-foreground">
                {log.target.catalogLabel}
              </div>
            )}
          </div>
        </TableCell>
        <TableCell
          className="hidden lg:table-cell font-mono text-xs max-w-[150px] truncate"
          title={log.resourceId || undefined}
        >
          {log.resourceId || "-"}
        </TableCell>
        <TableCell className="hidden lg:table-cell text-xs">
          {log.ipAddress || "-"}
        </TableCell>
        <TableCell className="hidden lg:table-cell text-xs">
          {formatUserAgent(log.userAgent)}
        </TableCell>
      </TableRow>
    );
  }

  // Multiple entries - render as expandable group
  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={onToggle}
      >
        <TableCell>
          <div className="flex items-center gap-2">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
            <Badge variant="secondary" className="gap-1">
              {group.entries.length}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">
              {formatTimestampRange(
                group.mostRecentTimestamp,
                group.oldestTimestamp
              )}
            </span>
          </div>
        </TableCell>
        <TableCell>
          <div className="space-y-1">
            <div title={group.entries[0]?.actor.secondaryLabel || undefined}>
              {group.entries[0]?.actor.label || t("system")}
            </div>
            {group.entries[0]?.actor.secondaryLabel && (
              <div className="text-xs text-muted-foreground">
                {group.entries[0].actor.secondaryLabel}
              </div>
            )}
          </div>
        </TableCell>
        <TableCell>
          <div className="space-y-2">
            <div className="font-medium leading-snug">
              {group.entries[0]?.summary || formatActionLabel(group.groupKey.action)}
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={getActionBadgeVariant(group.groupKey.action)}>
                {formatActionLabel(group.groupKey.action)}
              </Badge>
              {group.entries[0] && (
                <>
                  <Badge variant={getOutcomeBadgeVariant(group.entries[0].outcome)}>
                    {group.entries[0].outcome}
                  </Badge>
                  <Badge variant="outline">
                    {formatDomainLabel(group.entries[0].domain)}
                  </Badge>
                </>
              )}
            </div>
          </div>
        </TableCell>
        <TableCell className="hidden md:table-cell landscape-mobile:hidden">
          <div className="space-y-1">
            <div>{group.entries[0]?.target?.label || group.groupKey.resource}</div>
            {group.entries[0]?.target?.secondaryLabel && (
              <div className="text-xs text-muted-foreground">
                {group.entries[0].target.secondaryLabel}
              </div>
            )}
            {group.entries[0]?.target?.catalogLabel && (
              <div className="text-xs text-muted-foreground">
                {group.entries[0].target.catalogLabel}
              </div>
            )}
          </div>
        </TableCell>
        <TableCell
          className="hidden lg:table-cell font-mono text-xs max-w-[150px] truncate"
          title={group.groupKey.resourceId || undefined}
        >
          {group.groupKey.resourceId || "-"}
        </TableCell>
        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground" colSpan={2}>
          {t("groupedEntries", { count: group.entries.length })}
        </TableCell>
      </TableRow>

      {isExpanded &&
        group.entries.map((log, index) => (
          <ExpandedAuditRow
            key={log.id}
            log={log}
            isLast={index === group.entries.length - 1}
          />
        ))}
    </>
  );
}
