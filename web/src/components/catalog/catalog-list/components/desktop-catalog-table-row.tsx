"use client";

import { useLocale, useTranslations } from "next-intl";
import {
  AlertCircle,
  BadgeCheck,
  Calendar,
  CheckCircle2,
  Clock,
  Copy,
  Disc,
  Hash,
  MapPin,
  Mic,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPartialDate } from "@/lib/date-format";
import { parseDateFromString } from "@/lib/date-utils";
import { CacheStatusCell } from "@/components/catalog/cache-status-cell";
import {
  CheckboxCellEditor,
  DateCellEditor,
  EditableCell,
  NumberCellEditor,
  SelectCellEditor,
  TextCellEditor,
  type UseInlineEditReturn,
} from "@/components/catalog/inline-edit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type {
  MetadataAlbum,
  MetadataLocation,
  MetadataRecorder,
} from "@/hooks/use-metadata-enums";
import type { UseColumnResizeReturn } from "@/hooks/use-column-resize";
import type { CatalogEntry, ColumnKey } from "../types";

interface DesktopCatalogTableRowProps {
  activeCatalogId?: string | null;
  allAlbums: MetadataAlbum[];
  allLocations: MetadataLocation[];
  allRecorders: MetadataRecorder[];
  canManageAccess?: boolean;
  columnResize: UseColumnResizeReturn;
  columnVisibility: Record<ColumnKey, boolean>;
  entry: CatalogEntry;
  inlineEdit: UseInlineEditReturn;
  isPublishing: boolean;
  onOpenRecording: (hash: string) => void;
  onTogglePublication: (hash: string, isPublished: boolean) => void | Promise<void>;
}

function findSelectedOption<T extends { id: number; name: string }>(
  options: T[],
  id: number | null | undefined
) {
  return id ? options.find((option) => option.id === id) ?? null : null;
}

export function DesktopCatalogTableRow({
  activeCatalogId,
  allAlbums,
  allLocations,
  allRecorders,
  canManageAccess,
  columnResize,
  columnVisibility,
  entry,
  inlineEdit,
  isPublishing,
  onOpenRecording,
  onTogglePublication,
}: DesktopCatalogTableRowProps) {
  const locale = useLocale();
  const t = useTranslations("catalog");

  const displayTitle = entry.curatedTitle ?? entry.title;
  const displayArtist = entry.curatedArtist ?? entry.artist;
  const titleValue = inlineEdit.getCellValue(entry.hash, "title", displayTitle);
  const artistValue = inlineEdit.getCellValue(entry.hash, "artist", displayArtist);
  const verifiedValue = inlineEdit.getCellValue(
    entry.hash,
    "verified",
    entry.verified
  );

  const rowClickable =
    entry.isActionable && !inlineEdit.isEditMode && !columnResize.isResizing;

  const dateYear = inlineEdit.getCellValue(entry.hash, "dateYear", entry.dateYear);
  const dateMonth = inlineEdit.getCellValue(
    entry.hash,
    "dateMonth",
    entry.dateMonth
  );
  const dateDay = inlineEdit.getCellValue(entry.hash, "dateDay", entry.dateDay);
  const formattedDate = formatPartialDate(dateYear, dateMonth, dateDay, locale);

  const recorderId = inlineEdit.getCellValue(
    entry.hash,
    "recorderId",
    entry.recorderId
  );
  const recorderEdited = inlineEdit.isModified(entry.hash, "recorderId");
  const selectedRecorder = recorderId
    ? findSelectedOption(allRecorders, recorderId)
    : recorderEdited
      ? null
      : entry.recorder;

  const locationId = inlineEdit.getCellValue(
    entry.hash,
    "locationId",
    entry.locationId
  );
  const locationEdited = inlineEdit.isModified(entry.hash, "locationId");
  const selectedLocation = locationId
    ? findSelectedOption(allLocations, locationId)
    : locationEdited
      ? null
      : entry.location;

  const albumId = inlineEdit.getCellValue(entry.hash, "albumId", entry.albumId);
  const albumEdited = inlineEdit.isModified(entry.hash, "albumId");
  const selectedAlbum = albumId
    ? findSelectedOption(allAlbums, albumId)
    : albumEdited
      ? null
      : entry.album;

  const fallbackDate =
    dateYear == null && dateMonth == null && dateDay == null
      ? parseDateFromString(entry.date)
      : null;

  return (
    <TableRow
      data-testid="recording-row"
      className={cn(
        rowClickable
          ? "cursor-pointer hover:bg-muted/50"
          : !entry.isActionable
            ? "opacity-50"
            : "",
        inlineEdit.isModified(entry.hash) && "bg-amber-50/50 dark:bg-amber-950/20"
      )}
      onClick={rowClickable ? () => onOpenRecording(entry.hash) : undefined}
    >
      {columnVisibility.title && (
        <TableCell style={columnResize.getColumnStyle("title")}>
          <div className="flex items-center gap-2">
            <EditableCell
              hash={entry.hash}
              field="title"
              isEditMode={inlineEdit.isEditMode}
              isActive={
                inlineEdit.activeCell?.hash === entry.hash &&
                inlineEdit.activeCell?.field === "title"
              }
              isModified={inlineEdit.isModified(entry.hash, "title")}
              setActiveCell={inlineEdit.setActiveCell}
              clearActiveCell={inlineEdit.clearActiveCell}
              displayValue={
                <span
                  className={cn(
                    "truncate",
                    entry.isActionable ? "font-medium" : "text-muted-foreground"
                  )}
                  title={entry.filename || entry.hash}
                >
                  {titleValue || entry.filename || entry.hash.slice(0, 16)}
                </span>
              }
              editor={
                <TextCellEditor
                  value={titleValue}
                  onChange={(value) =>
                    inlineEdit.updateField(entry.hash, "title", value)
                  }
                  onCommit={() => inlineEdit.setActiveCell(null)}
                  onCancel={() => inlineEdit.revertField(entry.hash, "title")}
                  placeholder={entry.filename || entry.hash.slice(0, 16)}
                />
              }
            />
            {verifiedValue && (
              <span title="Verified">
                <BadgeCheck className="h-4 w-4 flex-shrink-0 text-green-600" />
              </span>
            )}
          </div>
        </TableCell>
      )}

      {columnVisibility.date && (
        <TableCell style={columnResize.getColumnStyle("date")}>
          <EditableCell
            hash={entry.hash}
            field="dateYear"
            isEditMode={inlineEdit.isEditMode}
            isActive={
              inlineEdit.activeCell?.hash === entry.hash &&
              (inlineEdit.activeCell?.field === "dateYear" ||
                inlineEdit.activeCell?.field === "dateMonth" ||
                inlineEdit.activeCell?.field === "dateDay")
            }
            isModified={
              inlineEdit.isModified(entry.hash, "dateYear") ||
              inlineEdit.isModified(entry.hash, "dateMonth") ||
              inlineEdit.isModified(entry.hash, "dateDay")
            }
            setActiveCell={inlineEdit.setActiveCell}
            clearActiveCell={inlineEdit.clearActiveCell}
            displayValue={
              formattedDate ? (
                <div className="flex items-center gap-1">
                  <Calendar className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="min-w-[85px] font-mono">{formattedDate}</span>
                </div>
              ) : entry.date ? (
                <div className="flex items-center gap-1">
                  <Calendar className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="min-w-[85px] font-mono">{entry.date}</span>
                </div>
              ) : (
                <span className="text-muted-foreground">-</span>
              )
            }
            editor={
              <DateCellEditor
                value={{
                  year: dateYear ?? fallbackDate?.year ?? null,
                  month: dateMonth ?? fallbackDate?.month ?? null,
                  day: dateDay ?? fallbackDate?.day ?? null,
                }}
                onChange={(value) => {
                  inlineEdit.updateField(entry.hash, "dateYear", value.year);
                  inlineEdit.updateField(entry.hash, "dateMonth", value.month);
                  inlineEdit.updateField(entry.hash, "dateDay", value.day);
                }}
                onCommit={() => inlineEdit.setActiveCell(null)}
                onCancel={() => {
                  inlineEdit.revertField(entry.hash, "dateYear");
                  inlineEdit.revertField(entry.hash, "dateMonth");
                  inlineEdit.revertField(entry.hash, "dateDay");
                }}
              />
            }
          />
        </TableCell>
      )}

      {columnVisibility.part && (
        <TableCell style={columnResize.getColumnStyle("part")}>
          <EditableCell
            hash={entry.hash}
            field="part"
            isEditMode={inlineEdit.isEditMode}
            isActive={
              inlineEdit.activeCell?.hash === entry.hash &&
              inlineEdit.activeCell?.field === "part"
            }
            isModified={inlineEdit.isModified(entry.hash, "part")}
            setActiveCell={inlineEdit.setActiveCell}
            clearActiveCell={inlineEdit.clearActiveCell}
            displayValue={
              inlineEdit.getCellValue(entry.hash, "part", entry.part) ? (
                <Badge variant="outline" className="gap-1">
                  <Hash className="h-3 w-3" />
                  {inlineEdit.getCellValue(entry.hash, "part", entry.part)}
                </Badge>
              ) : (
                <span className="text-muted-foreground">-</span>
              )
            }
            editor={
              <NumberCellEditor
                value={inlineEdit.getCellValue(entry.hash, "part", entry.part)}
                onChange={(value) =>
                  inlineEdit.updateField(entry.hash, "part", value)
                }
                onCommit={() => inlineEdit.setActiveCell(null)}
                onCancel={() => inlineEdit.revertField(entry.hash, "part")}
                min={1}
                placeholder="#"
              />
            }
          />
        </TableCell>
      )}

      {columnVisibility.recorder && (
        <TableCell style={columnResize.getColumnStyle("recorder")}>
          <EditableCell
            hash={entry.hash}
            field="recorderId"
            isEditMode={inlineEdit.isEditMode}
            isActive={
              inlineEdit.activeCell?.hash === entry.hash &&
              inlineEdit.activeCell?.field === "recorderId"
            }
            isModified={inlineEdit.isModified(entry.hash, "recorderId")}
            setActiveCell={inlineEdit.setActiveCell}
            clearActiveCell={inlineEdit.clearActiveCell}
            displayValue={
              selectedRecorder ? (
                <div className="flex items-center gap-1">
                  <Mic className="h-4 w-4 text-muted-foreground" />
                  {selectedRecorder.name}
                </div>
              ) : (
                <span className="text-muted-foreground">-</span>
              )
            }
            editor={
              <SelectCellEditor
                value={recorderId}
                onChange={(value) =>
                  inlineEdit.updateField(entry.hash, "recorderId", value)
                }
                onCommit={() => inlineEdit.setActiveCell(null)}
                options={allRecorders}
                placeholder={t("columns.recorder")}
              />
            }
          />
        </TableCell>
      )}

      {columnVisibility.location && (
        <TableCell style={columnResize.getColumnStyle("location")}>
          <EditableCell
            hash={entry.hash}
            field="locationId"
            isEditMode={inlineEdit.isEditMode}
            isActive={
              inlineEdit.activeCell?.hash === entry.hash &&
              inlineEdit.activeCell?.field === "locationId"
            }
            isModified={inlineEdit.isModified(entry.hash, "locationId")}
            setActiveCell={inlineEdit.setActiveCell}
            clearActiveCell={inlineEdit.clearActiveCell}
            displayValue={
              selectedLocation ? (
                <div className="flex items-center gap-1">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  {selectedLocation.name}
                </div>
              ) : (
                <span className="text-muted-foreground">-</span>
              )
            }
            editor={
              <SelectCellEditor
                value={locationId}
                onChange={(value) =>
                  inlineEdit.updateField(entry.hash, "locationId", value)
                }
                onCommit={() => inlineEdit.setActiveCell(null)}
                options={allLocations}
                placeholder={t("columns.location")}
              />
            }
          />
        </TableCell>
      )}

      {columnVisibility.duration && (
        <TableCell style={columnResize.getColumnStyle("duration")}>
          <div className="flex items-center gap-1">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {entry.duration || "--:--:--"}
          </div>
        </TableCell>
      )}

      {columnVisibility.artist && (
        <TableCell style={columnResize.getColumnStyle("artist")}>
          <EditableCell
            hash={entry.hash}
            field="artist"
            isEditMode={inlineEdit.isEditMode}
            isActive={
              inlineEdit.activeCell?.hash === entry.hash &&
              inlineEdit.activeCell?.field === "artist"
            }
            isModified={inlineEdit.isModified(entry.hash, "artist")}
            setActiveCell={inlineEdit.setActiveCell}
            clearActiveCell={inlineEdit.clearActiveCell}
            displayValue={artistValue || <span className="text-muted-foreground">-</span>}
            editor={
              <TextCellEditor
                value={artistValue}
                onChange={(value) =>
                  inlineEdit.updateField(entry.hash, "artist", value)
                }
                onCommit={() => inlineEdit.setActiveCell(null)}
                onCancel={() => inlineEdit.revertField(entry.hash, "artist")}
                placeholder={t("columns.artist")}
              />
            }
          />
        </TableCell>
      )}

      {columnVisibility.album && (
        <TableCell style={columnResize.getColumnStyle("album")}>
          <EditableCell
            hash={entry.hash}
            field="albumId"
            isEditMode={inlineEdit.isEditMode}
            isActive={
              inlineEdit.activeCell?.hash === entry.hash &&
              inlineEdit.activeCell?.field === "albumId"
            }
            isModified={inlineEdit.isModified(entry.hash, "albumId")}
            setActiveCell={inlineEdit.setActiveCell}
            clearActiveCell={inlineEdit.clearActiveCell}
            displayValue={
              selectedAlbum ? (
                <div className="flex items-center gap-1">
                  <Disc className="h-4 w-4 text-muted-foreground" />
                  {selectedAlbum.name}
                </div>
              ) : (
                <span className="text-muted-foreground">-</span>
              )
            }
            editor={
              <SelectCellEditor
                value={albumId}
                onChange={(value) =>
                  inlineEdit.updateField(entry.hash, "albumId", value)
                }
                onCommit={() => inlineEdit.setActiveCell(null)}
                options={allAlbums}
                placeholder={t("columns.album")}
              />
            }
          />
        </TableCell>
      )}

      {columnVisibility.status && (
        <TableCell style={columnResize.getColumnStyle("status")}>
          <div className="flex items-center gap-2">
            {entry.isActionable ? (
              entry.isPublished ? (
                <Badge variant="outline" className="gap-1 text-muted-foreground">
                  <CheckCircle2 className="h-3 w-3" />
                  {t("status.published")}
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-muted-foreground">
                  <AlertCircle className="h-3 w-3" />
                  {t("status.unpublished")}
                </Badge>
              )
            ) : (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <AlertCircle className="h-3 w-3" />
                {!entry.hasArchived && !entry.hasMetadata
                  ? t("status.missing")
                  : !entry.hasArchived
                    ? t("status.noAudio")
                    : t("status.noMetadata")}
              </Badge>
            )}

            {canManageAccess && entry.isActionable && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={isPublishing}
                onClick={(event) => {
                  event.stopPropagation();
                  void onTogglePublication(entry.hash, !entry.isPublished);
                }}
              >
                {isPublishing
                  ? t("status.updating")
                  : entry.isPublished
                    ? t("status.unpublish")
                    : t("status.publish")}
              </Button>
            )}
          </div>
        </TableCell>
      )}

      {columnVisibility.verified && (
        <TableCell style={columnResize.getColumnStyle("verified")}>
          {inlineEdit.isEditMode ? (
            <CheckboxCellEditor
              value={verifiedValue}
              onChange={(value) =>
                inlineEdit.updateField(entry.hash, "verified", value)
              }
            />
          ) : verifiedValue ? (
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          ) : (
            <X className="h-4 w-4 text-muted-foreground" />
          )}
        </TableCell>
      )}

      {columnVisibility.duplicates && (
        <TableCell style={columnResize.getColumnStyle("duplicates")}>
          {entry.duplicateCount && entry.duplicateCount > 0 ? (
            <Badge variant="outline" className="gap-1">
              <Copy className="h-3 w-3" />
              {entry.duplicateCount}
            </Badge>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
      )}

      {columnVisibility.offline && (
        <TableCell className="w-12" onClick={(event) => event.stopPropagation()}>
          {entry.isActionable && activeCatalogId && (
            <CacheStatusCell hash={entry.hash} catalogId={activeCatalogId} />
          )}
        </TableCell>
      )}
    </TableRow>
  );
}
