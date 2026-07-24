"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import type {
  MetadataAlbum,
  MetadataLocation,
  MetadataRecorder,
} from "@/hooks/use-metadata-enums";
import type { UseColumnResizeReturn } from "@/hooks/use-column-resize";
import type { UseInlineEditReturn } from "@/components/catalog/inline-edit";
import { NoMatchState } from "./empty-states";
import { DesktopCatalogTableHeader } from "./desktop-catalog-table-header";
import { DesktopCatalogTableRow } from "./desktop-catalog-table-row";
import type { ColumnKey, CatalogEntry } from "../types";
import type { UseCatalogFiltersReturn } from "../hooks/use-catalog-filters";

type CountedValueOption<T> = { value: T; count: number };
type CountedNamedOption = { id: number; name: string; count: number };

interface DesktopCatalogTableProps {
  activeCatalogId?: string | null;
  albums: CountedNamedOption[];
  allAlbums: MetadataAlbum[];
  allLocations: MetadataLocation[];
  allRecorders: MetadataRecorder[];
  artists: CountedValueOption<string>[];
  availableDurations: CountedValueOption<"short" | "medium" | "long">[];
  availableMonths: CountedValueOption<number>[];
  availableParts: CountedValueOption<number>[];
  availableStatuses: CountedValueOption<"ready" | "incomplete">[];
  availableVerified: CountedValueOption<boolean>[];
  availableYears: CountedValueOption<number>[];
  canManageAccess?: boolean;
  columnResize: UseColumnResizeReturn;
  columnVisibility: Record<ColumnKey, boolean>;
  duplicateCounts: CountedValueOption<number>[];
  entries: CatalogEntry[];
  filters: UseCatalogFiltersReturn;
  hasDuplicateCounts: boolean;
  hasDurations: boolean;
  hasStatuses: boolean;
  hasVerifiedOptions: boolean;
  inlineEdit: UseInlineEditReturn;
  lastVisibleColumnKey?: ColumnKey;
  locations: CountedNamedOption[];
  onOpenRecording: (hash: string) => void;
  onTogglePublication: (hash: string, isPublished: boolean) => void | Promise<void>;
  publishingHashes: Set<string>;
  recorders: CountedNamedOption[];
  visibleColumnKeys: ColumnKey[];
}

export function DesktopCatalogTable({
  activeCatalogId,
  albums,
  allAlbums,
  allLocations,
  allRecorders,
  artists,
  availableDurations,
  availableMonths,
  availableParts,
  availableStatuses,
  availableVerified,
  availableYears,
  canManageAccess,
  columnResize,
  columnVisibility,
  duplicateCounts,
  entries,
  filters,
  hasDuplicateCounts,
  hasDurations,
  hasStatuses,
  hasVerifiedOptions,
  inlineEdit,
  lastVisibleColumnKey,
  locations,
  onOpenRecording,
  onTogglePublication,
  publishingHashes,
  recorders,
  visibleColumnKeys,
}: DesktopCatalogTableProps) {
  return (
    <div className="hidden rounded-md border @[768px]/catalog:block landscape-mobile:hidden">
      <Table fixedLayout>
        <DesktopCatalogTableHeader
          albums={albums}
          artists={artists}
          availableDurations={availableDurations}
          availableMonths={availableMonths}
          availableParts={availableParts}
          availableStatuses={availableStatuses}
          availableVerified={availableVerified}
          availableYears={availableYears}
          columnResize={columnResize}
          columnVisibility={columnVisibility}
          duplicateCounts={duplicateCounts}
          filters={filters}
          hasDuplicateCounts={hasDuplicateCounts}
          hasDurations={hasDurations}
          hasStatuses={hasStatuses}
          hasVerifiedOptions={hasVerifiedOptions}
          lastVisibleColumnKey={lastVisibleColumnKey}
          locations={locations}
          recorders={recorders}
        />
        <TableBody>
          {entries.map((entry) => (
            <DesktopCatalogTableRow
              key={entry.hash}
              activeCatalogId={activeCatalogId}
              allAlbums={allAlbums}
              allLocations={allLocations}
              allRecorders={allRecorders}
              canManageAccess={canManageAccess}
              columnResize={columnResize}
              columnVisibility={columnVisibility}
              entry={entry}
              inlineEdit={inlineEdit}
              isPublishing={publishingHashes.has(entry.hash)}
              onOpenRecording={onOpenRecording}
              onTogglePublication={onTogglePublication}
            />
          ))}
          {entries.length === 0 && filters.hasActiveFilters && (
            <TableRow>
              <TableCell
                colSpan={visibleColumnKeys.length}
                className="h-32 text-center"
              >
                <NoMatchState
                  onClearFilters={filters.clearFilters}
                  className="flex flex-col items-center gap-2"
                />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
