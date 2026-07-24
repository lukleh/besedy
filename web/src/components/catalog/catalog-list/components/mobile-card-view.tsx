"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { AlertCircle, Calendar, Clock, Hash, MapPin, Mic } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { CatalogEntry } from "../types";
import { CacheButton } from "@/components/player/cache-button";
import { formatMediumDate } from "@/lib/date-format";

interface MobileCardViewProps {
  entries: CatalogEntry[];
  groupId: string;
}

function formatDate(year?: number | null, month?: number | null, day?: number | null): string | null {
  if (!year) return null;
  if (!month) return String(year);
  if (!day) return `${year}-${String(month).padStart(2, "0")}`;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function MobileCardView({ entries, groupId }: MobileCardViewProps) {
  const t = useTranslations("catalog");
  const router = useRouter();
  const locale = useLocale();

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 @[768px]/catalog:hidden landscape-mobile:block">
      {entries.map((entry) => {
        const fallbackTitle = entry.curatedTitle || entry.title || entry.filename || entry.hash.slice(0, 16);
        const dateStr = formatDate(entry.dateYear, entry.dateMonth, entry.dateDay);

        // Enhanced mode: use date + location as title when both fully available
        const hasFullDate = entry.dateYear && entry.dateMonth && entry.dateDay;
        const hasLocation = !!entry.location?.name;
        const useContextTitle = hasFullDate && hasLocation;

        // Format date for enhanced title (locale-aware: "10. Ledna 2026" / "Jan 10, 2026")
        const formattedDate = hasFullDate
          ? formatMediumDate(entry.dateYear!, entry.dateMonth!, entry.dateDay!, locale)
          : null;

        // Build metadata items based on mode
        const metadataItems: { key: string; icon: React.ReactNode; value: string }[] = [];

        if (!useContextTitle) {
          // Fallback mode: show date in metadata if available
          if (dateStr) {
            metadataItems.push({ key: "date", icon: <Calendar className="h-3 w-3 text-muted-foreground" />, value: dateStr });
          }
        }

        if (entry.part != null) {
          metadataItems.push({ key: "part", icon: <Hash className="h-3 w-3 text-muted-foreground" />, value: String(entry.part) });
        }
        if (entry.recorder?.name) {
          metadataItems.push({ key: "recorder", icon: <Mic className="h-3 w-3 text-muted-foreground" />, value: entry.recorder.name });
        }

        // Location only in fallback mode (in enhanced mode it's in the title)
        if (!useContextTitle && entry.location?.name) {
          metadataItems.push({ key: "location", icon: <MapPin className="h-3 w-3 text-muted-foreground" />, value: entry.location.name });
        }

        if (entry.duration) {
          metadataItems.push({ key: "duration", icon: <Clock className="h-3 w-3 text-muted-foreground" />, value: entry.duration });
        }

        // Status - show for incomplete rows and unpublished actionable rows
        const showStatus = !entry.isActionable || !entry.isPublished;
        const statusText = !entry.isActionable
          ? (!entry.hasArchived && !entry.hasMetadata
              ? t("status.missing")
              : !entry.hasArchived
                ? t("status.noAudio")
                : t("status.noMetadata"))
          : t("status.unpublished");

        return (
          <Card
            key={entry.hash}
            data-testid="recording-card"
            className={`py-0 ${
              entry.isActionable
                ? "cursor-pointer hover:bg-muted/50 active:bg-muted"
                : "opacity-50"
            }`}
            onClick={
              entry.isActionable
                ? () => router.push(`/catalog/${groupId}/recording/${entry.hash}`)
                : undefined
            }
          >
            <CardContent className="py-2 px-3 flex items-center gap-2">
              {/* Left side: title + metadata */}
              <div className="flex-1 min-w-0">
                {/* Title area - fixed height on phone for consistent cards (48px = 2 lines) */}
                <div className="min-h-12 @[400px]:min-h-0">
                  {useContextTitle ? (
                    // Enhanced: date + location with responsive layout
                    <div className={`font-medium ${!entry.isActionable ? "text-muted-foreground" : ""}`}>
                      <span className="truncate block @[400px]:inline">{formattedDate}</span>
                      <span className="hidden @[400px]:inline"> · </span>
                      <span className="truncate block @[400px]:inline">{entry.location!.name}</span>
                    </div>
                  ) : (
                    // Fallback: single title line
                    <div className={`font-medium truncate ${!entry.isActionable ? "text-muted-foreground" : ""}`}>
                      {fallbackTitle}
                    </div>
                  )}
                </div>

                {/* Metadata rows - fixed height for consistent cards, allows 2 lines */}
                <div className="flex flex-wrap items-center content-center gap-x-2 gap-y-0.5 mt-0.5 text-sm overflow-hidden h-10">
                  {metadataItems.map((item) => (
                    <span key={item.key} className="inline-flex items-center gap-1 shrink-0">
                      {item.icon}
                      {item.value}
                    </span>
                  ))}
                  {showStatus && (
                    <span className="inline-flex items-center gap-1 shrink-0">
                      <AlertCircle className="h-3 w-3 text-muted-foreground" />
                      {statusText}
                    </span>
                  )}
                </div>
              </div>

              {/* Right side: cache button, vertically centered */}
              {entry.isActionable && (
                <div onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
                  <CacheButton
                    audioUrl={`/api/catalogs/${groupId}/recordings/${entry.hash}/audio`}
                    hash={entry.hash}
                    catalogId={groupId}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
