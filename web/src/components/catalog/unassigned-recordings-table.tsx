"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { formatPartialDate } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface UnassignedEntry {
  audioHash: string;
  dateYear: number | null;
  dateMonth: number | null;
  dateDay: number | null;
  locationId: number | null;
  locationName: string | null;
  recorderName: string | null;
}

export interface UnassignedResponse {
  entries: UnassignedEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface UnassignedRecordingsTableProps {
  catalogId: string;
  entries: UnassignedEntry[];
  actionLabel: string;
  containerClassName?: string;
  emptyLabel: string;
  getRecordingHref?: (entry: UnassignedEntry) => string;
  isBusy?: boolean;
  isActionDisabled?: (entry: UnassignedEntry) => boolean;
  isActionPending?: (entry: UnassignedEntry) => boolean;
  getActionTitle?: (entry: UnassignedEntry) => string | undefined;
  onAction: (entry: UnassignedEntry) => void;
}

export function UnassignedRecordingsTable({
  catalogId,
  entries,
  actionLabel,
  containerClassName,
  emptyLabel,
  getRecordingHref,
  isBusy = false,
  isActionDisabled,
  isActionPending,
  getActionTitle,
  onAction,
}: UnassignedRecordingsTableProps) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("events.editor");

  function resolveRecordingHref(entry: UnassignedEntry) {
    return getRecordingHref?.(entry) ?? `/catalog/${catalogId}/recording/${entry.audioHash}`;
  }

  function openRecording(entry: UnassignedEntry) {
    router.push(resolveRecordingHref(entry));
  }

  function handleRowClick(
    event: MouseEvent<HTMLTableRowElement>,
    entry: UnassignedEntry
  ) {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        "a, button, input, select, textarea, label, [role='button'], [role='link'], [data-row-action]"
      )
    ) {
      return;
    }
    openRecording(entry);
  }

  function formatDate(dateYear: number | null, dateMonth: number | null, dateDay: number | null) {
    if (dateYear == null) {
      return t("unknownDate");
    }
    return formatPartialDate(dateYear, dateMonth, dateDay, locale) ?? String(dateYear);
  }

  return (
    <div className={cn("overflow-auto rounded-md border", containerClassName)}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columnDate")}</TableHead>
            <TableHead>{t("columnLocation")}</TableHead>
            <TableHead>{t("columnRecorder")}</TableHead>
            <TableHead>{t("columnHash")}</TableHead>
            <TableHead className="text-right">{t("columnActions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            const actionDisabled = isBusy || isActionDisabled?.(entry) === true;
            const actionPending = isActionPending?.(entry) === true;
            const actionTitle = getActionTitle?.(entry);

            return (
              <TableRow
                key={entry.audioHash}
                className="cursor-pointer"
                onClick={(event) => handleRowClick(event, entry)}
              >
                <TableCell>
                  {formatDate(entry.dateYear, entry.dateMonth, entry.dateDay)}
                </TableCell>
                <TableCell>{entry.locationName ?? t("unknownLocation")}</TableCell>
                <TableCell>{entry.recorderName ?? t("unknownRecorder")}</TableCell>
                <TableCell>
                  <Link
                    href={resolveRecordingHref(entry)}
                    className="font-mono text-xs underline-offset-2 hover:underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {entry.audioHash}
                  </Link>
                </TableCell>
                <TableCell className="text-right" data-row-action>
                  <Button
                    size="sm"
                    className="whitespace-nowrap"
                    onClick={(event) => {
                      event.stopPropagation();
                      onAction(entry);
                    }}
                    disabled={actionDisabled}
                    title={actionTitle}
                  >
                    {actionPending ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : null}
                    {actionLabel}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {entries.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-sm text-muted-foreground">
                {emptyLabel}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
