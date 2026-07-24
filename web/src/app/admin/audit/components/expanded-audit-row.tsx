"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileText, ChevronDown, ChevronRight } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AuditLog } from "../types";
import { formatUserAgent } from "../utils";

interface ExpandedAuditRowProps {
  log: AuditLog;
  isLast: boolean;
}

export function ExpandedAuditRow({ log, isLast }: ExpandedAuditRowProps) {
  const t = useTranslations("admin.audit");
  const [showDetails, setShowDetails] = useState(false);
  const detailSource = log.rawDetails ?? log.details;
  const hasDetails = detailSource && Object.keys(detailSource).length > 0;

  return (
    <>
      <TableRow
        className={`bg-muted/20 border-l-2 border-l-primary/30 ${
          isLast && !showDetails ? "border-b" : ""
        }`}
      >
        <TableCell className="pl-12">
          <div className="space-y-1">
            <span className="font-mono text-xs">
              {new Date(log.createdAt)
                .toISOString()
                .replace("T", " ")
                .slice(0, 19)}
            </span>
            <div className="text-sm font-medium leading-snug">{log.summary}</div>
            {log.target && (
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>{log.target.label}</span>
                {log.target.secondaryLabel && <span>{log.target.secondaryLabel}</span>}
                {log.target.catalogLabel && (
                  <Badge variant="outline" className="text-[10px]">
                    {log.target.catalogLabel}
                  </Badge>
                )}
              </div>
            )}
          </div>
        </TableCell>
        {/* Mobile: span remaining 2 visible columns */}
        <TableCell colSpan={2} className="md:hidden">
          {hasDetails && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setShowDetails(!showDetails)}
            >
              {showDetails ? (
                <ChevronDown className="h-3 w-3 mr-1" />
              ) : (
                <ChevronRight className="h-3 w-3 mr-1" />
              )}
              <FileText className="h-3 w-3 mr-1" />
              {showDetails ? t("hideDetails") : t("showDetails")}
            </Button>
          )}
        </TableCell>
        {/* md: span 3 visible columns (User, Action, Resource) */}
        <TableCell colSpan={3} className="hidden md:table-cell lg:hidden landscape-mobile:hidden">
          {hasDetails && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setShowDetails(!showDetails)}
            >
              {showDetails ? (
                <ChevronDown className="h-3 w-3 mr-1" />
              ) : (
                <ChevronRight className="h-3 w-3 mr-1" />
              )}
              <FileText className="h-3 w-3 mr-1" />
              {showDetails ? t("hideDetails") : t("showDetails")}
            </Button>
          )}
        </TableCell>
        {/* lg+: span 4 columns (User, Action, Resource, ResourceId) */}
        <TableCell colSpan={4} className="hidden lg:table-cell">
          {hasDetails && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setShowDetails(!showDetails)}
            >
              {showDetails ? (
                <ChevronDown className="h-3 w-3 mr-1" />
              ) : (
                <ChevronRight className="h-3 w-3 mr-1" />
              )}
              <FileText className="h-3 w-3 mr-1" />
              {showDetails ? t("hideDetails") : t("showDetails")}
            </Button>
          )}
        </TableCell>
        <TableCell className="hidden lg:table-cell text-xs">
          {log.ipAddress || "-"}
        </TableCell>
        <TableCell className="hidden lg:table-cell text-xs">
          {formatUserAgent(log.userAgent)}
        </TableCell>
      </TableRow>

      {/* Details JSON row */}
      {showDetails && hasDetails && (
        <TableRow
          className={`bg-muted/10 border-l-2 border-l-primary/30 ${
            isLast ? "border-b" : ""
          }`}
        >
          <TableCell colSpan={7} className="pl-12 py-2">
            <pre className="text-xs font-mono p-3 bg-muted rounded overflow-x-auto max-h-64 overflow-y-auto">
              {JSON.stringify(detailSource, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
