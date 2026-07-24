"use client";

import { useTranslations } from "next-intl";
import { Copy, AlertTriangle } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trimScanRoot } from "@/lib/utils";
import type { DuplicateInfo, SourceMetadataFields } from "@/types/catalog";

interface DuplicatesViewerProps {
  duplicates: DuplicateInfo[];
  originalMetadata: SourceMetadataFields | null;
}

// Metadata fields to display
const METADATA_FIELDS = [
  { key: "title", labelKey: "title" },
  { key: "artist", labelKey: "artist" },
  { key: "album", labelKey: "album" },
  { key: "date", labelKey: "date" },
  { key: "genre", labelKey: "genre" },
  { key: "track", labelKey: "track" },
  { key: "comment", labelKey: "comment" },
  { key: "encodedBy", labelKey: "encodedBy" },
  { key: "encoder", labelKey: "encoder" },
] as const;

type FieldKey = (typeof METADATA_FIELDS)[number]["key"];

export function DuplicatesViewer({
  duplicates,
  originalMetadata,
}: DuplicatesViewerProps) {
  const t = useTranslations("duplicates");

  if (duplicates.length === 0) {
    return null;
  }

  // Check if a field differs from original
  const isDifferent = (field: FieldKey, dupValue: string | undefined): boolean => {
    if (!originalMetadata) return false;
    const originalValue = originalMetadata[field] || "";
    const duplicateValue = dupValue || "";
    return originalValue !== duplicateValue && (originalValue !== "" || duplicateValue !== "");
  };

  // Count differences for a duplicate
  const countDiffs = (dup: DuplicateInfo): number => {
    if (!originalMetadata) return 0;
    return METADATA_FIELDS.filter(({ key }) => isDifferent(key, dup[key])).length;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Copy className="h-5 w-5" />
          {t("title")}
          <Badge variant="secondary">{duplicates.length}</Badge>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {duplicates.map((dup, index) => {
          const diffCount = countDiffs(dup);

          return (
            <div key={index} className="border rounded-lg p-4 space-y-3">
              {/* Path info */}
              <div className="space-y-1">
                <div className="text-sm">
                  <span className="text-muted-foreground">
                    {t("duplicatePath")}:
                  </span>
                  <code
                    className="ml-2 text-xs bg-muted px-1 py-0.5 rounded break-all"
                    title={dup.duplicatePath}
                  >
                    {trimScanRoot(dup.duplicatePath, dup.scanRoot)}
                  </code>
                </div>
                <div className="flex gap-4 text-sm text-muted-foreground">
                  {dup.sizeHuman && <span>{dup.sizeHuman}</span>}
                  {dup.duration && <span>{dup.duration}</span>}
                  {diffCount > 0 && (
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" />
                      {t("diffCount", { count: diffCount })}
                    </span>
                  )}
                </div>
              </div>

              {/* All metadata fields */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {METADATA_FIELDS.map(({ key, labelKey }) => {
                  const value = dup[key];
                  const differs = isDifferent(key, value);
                  const originalValue = originalMetadata?.[key];

                  return (
                    <div key={key} className={key === "comment" ? "col-span-2" : ""}>
                      <span className="text-muted-foreground">
                        {t(`fields.${labelKey}`)}:
                      </span>{" "}
                      <span className={differs ? "inline-flex items-center gap-1" : ""}>
                        {value || <span className="text-muted-foreground italic">-</span>}
                        {differs && (
                          <span
                            className="inline-flex items-center text-amber-600 dark:text-amber-400"
                            title={`${t("original")}: ${originalValue || "(empty)"}`}
                          >
                            <AlertTriangle className="h-3 w-3" />
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
