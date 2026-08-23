"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  ChevronDown,
  ChevronUp,
  Filter,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import { fetchJson } from "@/lib/api/fetch-json";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useIsDesktop } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CatalogPagination } from "@/components/catalog/catalog-list/components/pagination";
import {
  MobileSearchOverlay,
  RagSearchBar,
  RagSearchResults,
} from "@/components/catalog/catalog-list/components";
import {
  DeepSearchAction,
  DeepSearchIconAction,
} from "@/components/catalog/deep-search-action";
import {
  useRagSearch,
  type RagSearchResult,
} from "@/components/catalog/catalog-list/hooks";
import {
  buildEventListParams,
  clearStoredEventListState,
  loadStoredEventListState,
  saveEventListState,
} from "./event-list-storage";
import { EventListCreateDialog } from "./event-list-create-dialog";
import { EventListResults } from "./event-list-results";
import type {
  CatalogEventRow,
  CreateEventPayload,
  EventListProps,
  EventListQueryState,
  EventListResponse,
  EventSortKey,
  LocationItem,
  SortDirection,
  StoredEventListState,
} from "./event-list-types";
import {
  eventListResponseSchema,
  locationItemSchema,
  toPaginationInfo,
} from "./event-list-types";

interface EventHealthResponse {
  unassignedRecordings: number;
}

const eventHealthResponseSchema = z.object({
  unassignedRecordings: z.number(),
});

export function EventList({
  catalogId,
  canEdit,
  showAllColumns,
  showReleaseState,
  deepSearchHref,
}: EventListProps) {
  // Owns the query state and page behavior for catalog events. Data shapes and
  // localStorage plumbing live in adjacent modules so this file stays focused
  // on the interactive workflow.
  const t = useTranslations("events.list");
  const tCommon = useTranslations("events.common");
  const tCatalog = useTranslations("catalog");
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [releasedFilter, setReleasedFilter] = useState<
    "all" | "true" | "false"
  >("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [dateYearFilter, setDateYearFilter] = useState("all");
  const [sortKey, setSortKey] = useState<EventSortKey>("date");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [filtersReady, setFiltersReady] = useState(false);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);

  const [locationId, setLocationId] = useState("");
  const [dateYear, setDateYear] = useState("");
  const [dateMonth, setDateMonth] = useState("");
  const [dateDay, setDateDay] = useState("");
  const [sessionIndex, setSessionIndex] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const [isLoadMoreMode, setIsLoadMoreMode] = useState(false);
  const [accumulatedEvents, setAccumulatedEvents] = useState<CatalogEventRow[]>(
    [],
  );
  const [highestLoadedPage, setHighestLoadedPage] = useState(0);
  const [isLoadingNext, setIsLoadingNext] = useState(false);
  const [isLoadingAll, setIsLoadingAll] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  useEffect(() => {
    setFiltersReady(false);
    const stored = loadStoredEventListState(catalogId);
    if (stored) {
      if (
        showReleaseState &&
        (stored.releasedFilter === "all" ||
          stored.releasedFilter === "true" ||
          stored.releasedFilter === "false")
      ) {
        setReleasedFilter(stored.releasedFilter);
      } else {
        setReleasedFilter("all");
      }

      if (
        typeof stored.locationFilter === "string" &&
        stored.locationFilter.length > 0
      ) {
        setLocationFilter(stored.locationFilter);
      } else {
        setLocationFilter("all");
      }

      if (
        typeof stored.dateYearFilter === "string" &&
        stored.dateYearFilter.length > 0
      ) {
        setDateYearFilter(stored.dateYearFilter);
      } else {
        setDateYearFilter("all");
      }

      if (
        stored.sortKey === "date" ||
        stored.sortKey === "location" ||
        (showAllColumns &&
          (stored.sortKey === "recordingCount" ||
            stored.sortKey === "released"))
      ) {
        setSortKey(stored.sortKey);
      } else {
        setSortKey("date");
      }

      if (stored.sortDir === "asc" || stored.sortDir === "desc") {
        setSortDir(stored.sortDir);
      } else {
        setSortDir("desc");
      }

      if (typeof stored.page === "number" && stored.page > 0) {
        setPage(stored.page);
      } else {
        setPage(1);
      }
    } else {
      setReleasedFilter("all");
      setLocationFilter("all");
      setDateYearFilter("all");
      setSortKey("date");
      setSortDir("desc");
      setPage(1);
    }

    setShowMobileFilters(false);
    setFiltersReady(true);
  }, [catalogId, showAllColumns, showReleaseState]);

  // Mobile only exposes date sorting. Keep an unsupported desktop sort in
  // storage, though, so merely opening or resizing the mobile view does not
  // erase the user's desktop preference.
  const effectiveSortKey: EventSortKey = isDesktop ? sortKey : "date";
  const effectiveSortDir: SortDirection = isDesktop
    ? sortDir
    : sortKey === "date"
      ? sortDir
      : "desc";

  const queryState = useMemo<EventListQueryState>(
    () => ({
      releasedFilter,
      locationFilter,
      dateYearFilter,
      sortKey: effectiveSortKey,
      sortDir: effectiveSortDir,
    }),
    [
      releasedFilter,
      locationFilter,
      dateYearFilter,
      effectiveSortKey,
      effectiveSortDir,
    ],
  );

  const listStateKey = useMemo(
    () =>
      `${catalogId}|${page}|${releasedFilter}|${locationFilter}|${dateYearFilter}|${effectiveSortKey}|${effectiveSortDir}`,
    [
      catalogId,
      page,
      releasedFilter,
      locationFilter,
      dateYearFilter,
      effectiveSortKey,
      effectiveSortDir,
    ],
  );
  const listStateKeyRef = useRef(listStateKey);

  const listQueryKey = useMemo(
    () =>
      [
        "catalog-events",
        catalogId,
        page,
        releasedFilter,
        locationFilter,
        dateYearFilter,
        effectiveSortKey,
        effectiveSortDir,
      ] as const,
    [
      catalogId,
      page,
      releasedFilter,
      locationFilter,
      dateYearFilter,
      effectiveSortKey,
      effectiveSortDir,
    ],
  );

  useEffect(() => {
    if (!filtersReady) return;

    const state: StoredEventListState = {
      releasedFilter: releasedFilter !== "all" ? releasedFilter : undefined,
      locationFilter: locationFilter !== "all" ? locationFilter : undefined,
      dateYearFilter: dateYearFilter !== "all" ? dateYearFilter : undefined,
      sortKey: sortKey !== "date" ? sortKey : undefined,
      sortDir: sortDir !== "desc" ? sortDir : undefined,
      page: page > 1 ? page : undefined,
    };

    const hasStoredValues = Object.values(state).some(
      (value) => value !== undefined,
    );
    if (hasStoredValues) {
      saveEventListState(catalogId, state);
    } else {
      clearStoredEventListState(catalogId);
    }
  }, [
    catalogId,
    filtersReady,
    releasedFilter,
    locationFilter,
    dateYearFilter,
    sortKey,
    sortDir,
    page,
  ]);

  const { data, isLoading, isFetching, error } = useQuery<EventListResponse>({
    queryKey: listQueryKey,
    queryFn: async () => {
      const params = buildEventListParams(catalogId, page, 50, queryState);
      return fetchJson<EventListResponse>(
        `/api/catalog-events?${params.toString()}`,
        {
          schema: eventListResponseSchema,
        }
      );
    },
    enabled: filtersReady,
  });

  useEffect(() => {
    const totalPages = data?.pagination?.totalPages;
    if (!totalPages) return;
    if (page > totalPages) {
      setPage(1);
    }
  }, [data?.pagination?.totalPages, page]);

  const { data: metadataLocations = [] } = useQuery<LocationItem[]>({
    queryKey: ["locations", catalogId],
    queryFn: () =>
      fetchJson<LocationItem[]>(`/api/metadata/locations?group=${catalogId}`, {
        schema: z.array(locationItemSchema),
      }),
  });

  const { data: eventHealth } = useQuery<EventHealthResponse>({
    queryKey: ["catalog-events-health", catalogId],
    queryFn: () =>
      fetchJson<EventHealthResponse>(
        `/api/catalogs/${catalogId}/events/health`,
        {
          schema: eventHealthResponseSchema,
        }
      ),
    enabled: canEdit,
  });

  const handleRagSessionRestore = useCallback(() => {
    if (!isDesktop) {
      setSearchOverlayOpen(true);
    }
  }, [isDesktop]);

  const rag = useRagSearch({
    activeCatalogId: catalogId,
    canUseRagSearch: true,
    sessionScope: "events",
    dataLoaded: !!data,
    onSessionRestore: handleRagSessionRestore,
  });

  useEffect(() => {
    if (isDesktop && searchOverlayOpen) {
      setSearchOverlayOpen(false);
      return;
    }

    if (!isDesktop && rag.isRagMode && !searchOverlayOpen) {
      setSearchOverlayOpen(true);
    }
  }, [isDesktop, rag.isRagMode, searchOverlayOpen]);

  useEffect(() => {
    listStateKeyRef.current = listStateKey;
    setIsLoadMoreMode(false);
    setAccumulatedEvents([]);
    setHighestLoadedPage(0);
    setIsLoadingNext(false);
    setIsLoadingAll(false);
    setLoadMoreError(null);
  }, [listStateKey]);

  const createMutation = useMutation({
    mutationFn: async (payload: CreateEventPayload) => {
      return fetchJson("/api/catalog-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["catalog-events", catalogId],
      });
      queryClient.invalidateQueries({
        queryKey: ["catalog-events-health", catalogId],
      });
      setIsLoadMoreMode(false);
      setAccumulatedEvents([]);
      setHighestLoadedPage(0);
      setCreateOpen(false);
      setLocationId("");
      setDateYear("");
      setDateMonth("");
      setDateDay("");
      setSessionIndex("");
      setTitle("");
      setDescription("");
      toast({ title: t("toastCreated") });
    },
    onError: (err: Error) => {
      toast({
        title: t("toastCreateFailed"),
        description: err.message,
        variant: "destructive",
      });
    },
  });

  function handleSort(key: EventSortKey) {
    if (!showAllColumns && key !== "date" && key !== "location") {
      return;
    }

    if (sortKey === key) {
      if (sortDir === "desc") {
        setSortDir("asc");
      } else {
        setSortKey("date");
        setSortDir("desc");
      }
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(1);
  }

  function handleMobileDateSort() {
    setSortKey("date");
    setSortDir(effectiveSortDir === "desc" ? "asc" : "desc");
    setPage(1);
  }

  function clearFilters() {
    setReleasedFilter("all");
    setLocationFilter("all");
    setDateYearFilter("all");
    setPage(1);
    clearStoredEventListState(catalogId);
  }

  function handlePageChange(nextPage: number) {
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function loadNextPage() {
    if (!data || isLoadingNext || isLoadingAll) return;

    const nextPage = isLoadMoreMode ? highestLoadedPage + 1 : page + 1;
    if (nextPage > data.pagination.totalPages) return;

    const requestStateKey = listStateKeyRef.current;
    setIsLoadingNext(true);
    setLoadMoreError(null);

    try {
      const params = buildEventListParams(catalogId, nextPage, 50, queryState);
      const nextData = await fetchJson<EventListResponse>(
        `/api/catalog-events?${params.toString()}`,
        {
          schema: eventListResponseSchema,
        }
      );

      if (requestStateKey !== listStateKeyRef.current) return;

      if (isLoadMoreMode) {
        setAccumulatedEvents((current) => [...current, ...nextData.events]);
      } else {
        setAccumulatedEvents([...(data.events ?? []), ...nextData.events]);
        setIsLoadMoreMode(true);
      }
      setHighestLoadedPage(nextPage);
    } catch (err) {
      if (requestStateKey !== listStateKeyRef.current) return;
      const message = err instanceof Error ? err.message : t("loadNextError");
      setLoadMoreError(message);
    } finally {
      if (requestStateKey === listStateKeyRef.current) {
        setIsLoadingNext(false);
      }
    }
  }

  async function loadAllPages() {
    if (!data || isLoadingNext || isLoadingAll) return;
    if (data.pagination.totalPages <= 1) return;

    const requestStateKey = listStateKeyRef.current;
    setIsLoadingAll(true);
    setLoadMoreError(null);

    try {
      const params = buildEventListParams(catalogId, 1, 0, queryState);
      const allData = await fetchJson<EventListResponse>(
        `/api/catalog-events?${params.toString()}`,
        {
          schema: eventListResponseSchema,
        }
      );

      if (requestStateKey !== listStateKeyRef.current) return;

      setAccumulatedEvents(allData.events);
      setHighestLoadedPage(data.pagination.totalPages);
      setIsLoadMoreMode(true);
    } catch (err) {
      if (requestStateKey !== listStateKeyRef.current) return;
      const message = err instanceof Error ? err.message : t("loadAllError");
      setLoadMoreError(message);
    } finally {
      if (requestStateKey === listStateKeyRef.current) {
        setIsLoadingAll(false);
      }
    }
  }

  function submitCreateEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsedLocationId = Number.parseInt(locationId, 10);
    const parsedDateYear = Number.parseInt(dateYear, 10);
    const parsedDateMonth = dateMonth ? Number.parseInt(dateMonth, 10) : null;
    const parsedDateDay = dateDay ? Number.parseInt(dateDay, 10) : null;
    const parsedSessionIndex = sessionIndex
      ? Number.parseInt(sessionIndex, 10)
      : null;

    if (!Number.isFinite(parsedLocationId) || parsedLocationId <= 0) {
      toast({
        title: tCommon("validationLocationRequired"),
        variant: "destructive",
      });
      return;
    }
    if (!Number.isFinite(parsedDateYear) || parsedDateYear < 1900) {
      toast({
        title: tCommon("validationYearRequired"),
        variant: "destructive",
      });
      return;
    }
    if (parsedDateDay !== null && parsedDateMonth === null) {
      toast({
        title: tCommon("validationMonthRequired"),
        description: tCommon("validationMonthRequiredDescription"),
        variant: "destructive",
      });
      return;
    }
    if (
      parsedSessionIndex !== null &&
      (!Number.isFinite(parsedSessionIndex) || parsedSessionIndex < 1)
    ) {
      toast({
        title: tCommon("validationSessionIndexRequired"),
        variant: "destructive",
      });
      return;
    }

    createMutation.mutate({
      workflowGroupId: catalogId,
      locationId: parsedLocationId,
      dateYear: parsedDateYear,
      dateMonth: parsedDateMonth,
      dateDay: parsedDateDay,
      ...(parsedSessionIndex !== null ? { sessionIndex: parsedSessionIndex } : {}),
      title: title.trim() || null,
      description: description.trim() || null,
    });
  }

  if (!filtersReady || isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-6 text-sm text-destructive">
        {t("loadError", { message: error.message })}
      </div>
    );
  }

  const baseEvents = data?.events ?? [];
  const events = isLoadMoreMode ? accumulatedEvents : baseEvents;
  const pagination = data?.pagination;
  const yearOptions = data?.filterOptions?.years ?? [];
  const locationOptions = data?.filterOptions?.locations ?? [];

  const paginationInfo = pagination ? toPaginationInfo(pagination) : null;
  const hasMoreToLoad = pagination
    ? isLoadMoreMode
      ? highestLoadedPage < pagination.totalPages
      : pagination.page < pagination.totalPages
    : false;
  const hasActiveFilters =
    (showReleaseState && releasedFilter !== "all") ||
    locationFilter !== "all" ||
    dateYearFilter !== "all";
  const totalFiltered = pagination?.total ?? 0;
  const totalAll = pagination?.totalAll ?? totalFiltered;
  const activeFilterCount = [
    showReleaseState && releasedFilter !== "all",
    locationFilter !== "all",
    dateYearFilter !== "all",
  ].filter(Boolean).length;
  const unassignedCount = eventHealth?.unassignedRecordings ?? 0;
  const canOpenUnassigned = unassignedCount > 0;

  const openMobileSearchOverlay = () => setSearchOverlayOpen(true);
  const closeMobileSearchOverlay = () => {
    setSearchOverlayOpen(false);
    rag.hideRagMode();
  };
  const openRagResult = (result: RagSearchResult) => {
    const seek = result.startSec ?? 0;
    router.push(
      `/catalog/${catalogId}/recording/${result.audioHash}?seek=${encodeURIComponent(
        String(seek),
      )}&fromSearch=1`,
    );
  };

  return (
    <div
      className={cn(
        "@container/catalog space-y-4 transition-opacity duration-200",
        isFetching && !isLoading && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-sm text-muted-foreground">
            {hasActiveFilters
              ? t("countFiltered", { filtered: totalFiltered, total: totalAll })
              : t("count", { total: totalAll })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="@[768px]/catalog:hidden landscape-mobile:inline-flex"
            onClick={openMobileSearchOverlay}
            aria-label={tCatalog("ragSearch.placeholder")}
            data-testid="mobile-rag-search-button"
          >
            <Search className="h-4 w-4" />
          </Button>
          {deepSearchHref ? (
            <DeepSearchIconAction
              href={deepSearchHref}
              label={tCatalog("deepSearch.label")}
              className="@[768px]/catalog:hidden landscape-mobile:inline-flex"
            />
          ) : null}
          {hasActiveFilters && (
            <Button
              variant="outline"
              size="sm"
              onClick={clearFilters}
              className="hidden @[768px]/catalog:inline-flex landscape-mobile:hidden"
            >
              {t("clearFilters")}
            </Button>
          )}
          {canEdit && (
            <>
              {canOpenUnassigned ? (
                <Button asChild>
                  <Link href={`/catalog/${catalogId}/events/unassigned`}>
                    {t("unassignedRecordingsWithCount", {
                      count: unassignedCount,
                    })}
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" disabled>
                  {t("unassignedRecordingsWithCount", {
                    count: unassignedCount,
                  })}
                </Button>
              )}
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1 h-4 w-4" />
                {t("createEvent")}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="hidden items-stretch gap-3 @[768px]/catalog:flex landscape-mobile:hidden">
        <div className="min-w-0 flex-1">
          <RagSearchBar
            ragQuery={rag.ragQuery}
            setRagQuery={rag.setRagQuery}
            isRagMode={rag.isRagMode}
            ragLoading={rag.ragLoading}
            onSubmit={rag.handleRagSubmit}
            onBack={() => rag.exitRagMode(false)}
            onClear={() =>
              rag.isRagMode ? rag.exitRagMode(true) : rag.setRagQuery("")
            }
          />
        </div>
        {deepSearchHref ? (
          <DeepSearchAction
            href={deepSearchHref}
            label={tCatalog("deepSearch.label")}
          />
        ) : null}
      </div>

      {rag.isRagMode ? (
        <div className="hidden space-y-3 @[768px]/catalog:block landscape-mobile:hidden">
          <span className="text-sm" aria-live="polite">
            {tCatalog("ragSearch.resultsCount", {
              count: rag.ragResults.length,
            })}
          </span>
          <RagSearchResults
            results={rag.ragResults}
            loading={rag.ragLoading}
            error={rag.ragError}
            onRetry={() => {
              void rag.executeRagSearch(rag.ragSubmittedQuery || rag.ragQuery);
            }}
            onOpenResult={openRagResult}
          />
        </div>
      ) : null}

      <div className="@[768px]/catalog:hidden landscape-mobile:block">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowMobileFilters((current) => !current)}
            className="h-9 flex-1 justify-between"
          >
            <span className="flex items-center gap-2">
              <Filter className="h-4 w-4" />
              {t("filters")}
              {hasActiveFilters && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                  {activeFilterCount}
                </span>
              )}
            </span>
            {showMobileFilters ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleMobileDateSort}
            className="h-9 shrink-0 px-3"
            aria-label={
              effectiveSortDir === "desc"
                ? t("sortNewestFirst")
                : t("sortOldestFirst")
            }
            data-testid="mobile-event-date-sort"
          >
            {effectiveSortDir === "desc" ? (
              <ArrowDownNarrowWide className="mr-2 h-4 w-4" />
            ) : (
              <ArrowUpNarrowWide className="mr-2 h-4 w-4" />
            )}
            <span className="hidden min-[360px]:inline">
              {effectiveSortDir === "desc"
                ? t("sortNewest")
                : t("sortOldest")}
            </span>
          </Button>
          {hasActiveFilters && (
            <Button
              variant="outline"
              onClick={() => {
                clearFilters();
                setShowMobileFilters(false);
              }}
            >
              {t("clear")}
            </Button>
          )}
        </div>

        {showMobileFilters && (
          <div className="mt-3 space-y-3 rounded-lg border bg-muted/30 p-4">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t("columnDate")}
              </Label>
              <select
                value={dateYearFilter}
                onChange={(event) => {
                  setDateYearFilter(event.target.value);
                  setPage(1);
                }}
                className={cn(
                  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm",
                  dateYearFilter !== "all" && "border-primary",
                )}
                aria-label={t("dateYearFilterAria")}
              >
                <option value="all">{t("allYears")}</option>
                {yearOptions.map((year) => (
                  <option key={year} value={year.toString()}>
                    {year}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t("columnLocation")}
              </Label>
              <select
                value={locationFilter}
                onChange={(event) => {
                  setLocationFilter(event.target.value);
                  setPage(1);
                }}
                className={cn(
                  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm",
                  locationFilter !== "all" && "border-primary",
                )}
                aria-label={t("locationFilterAria")}
              >
                <option value="all">{t("allLocations")}</option>
                {locationOptions.map((location) => (
                  <option key={location.id} value={location.id.toString()}>
                    {location.name}
                  </option>
                ))}
              </select>
            </div>

            {showReleaseState ? (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  {t("columnStatus")}
                </Label>
                <select
                  value={releasedFilter}
                  onChange={(event) => {
                    setReleasedFilter(
                      event.target.value as "all" | "true" | "false",
                    );
                    setPage(1);
                  }}
                  className={cn(
                    "h-9 w-full rounded-md border border-input bg-background px-3 text-sm",
                    releasedFilter !== "all" && "border-primary",
                  )}
                  aria-label={t("statusFilterAria")}
                >
                  <option value="all">{t("all")}</option>
                  <option value="true">{t("released")}</option>
                  <option value="false">{t("unreleased")}</option>
                </select>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!rag.isRagMode ? (
        <EventListResults
          catalogId={catalogId}
          dateYearFilter={dateYearFilter}
          events={events}
          hasActiveFilters={hasActiveFilters}
          locationFilter={locationFilter}
          locationOptions={locationOptions}
          onDateYearFilterChange={(value) => {
            setDateYearFilter(value);
            setPage(1);
          }}
          onLocationFilterChange={(value) => {
            setLocationFilter(value);
            setPage(1);
          }}
          onReleasedFilterChange={(value) => {
            setReleasedFilter(value);
            setPage(1);
          }}
          onSort={handleSort}
          releasedFilter={releasedFilter}
          showAllColumns={showAllColumns}
          showReleaseState={showReleaseState}
          sortDir={sortDir}
          sortKey={sortKey}
          yearOptions={yearOptions}
        />
      ) : null}

      {loadMoreError && (
        <div className="text-sm text-destructive">{loadMoreError}</div>
      )}

      {!rag.isRagMode && paginationInfo && (
        <CatalogPagination
          pagination={paginationInfo}
          onPageChange={handlePageChange}
          onLoadNext={loadNextPage}
          onLoadAll={loadAllPages}
          isLoadingNext={isLoadingNext}
          isLoadingAll={isLoadingAll}
          isLoadMoreMode={isLoadMoreMode}
          loadedCount={events.length}
          totalCount={pagination?.total}
          hasMoreToLoad={hasMoreToLoad}
        />
      )}

      <MobileSearchOverlay
        open={searchOverlayOpen}
        ragQuery={rag.ragQuery}
        ragSubmittedQuery={rag.ragSubmittedQuery}
        ragResults={rag.ragResults}
        ragLoading={rag.ragLoading}
        ragError={rag.ragError}
        setRagQuery={rag.setRagQuery}
        onSubmit={rag.handleRagSubmit}
        onRetry={() => {
          void rag.executeRagSearch(rag.ragSubmittedQuery || rag.ragQuery);
        }}
        onOpenResult={openRagResult}
        onClear={() => rag.exitRagMode(true)}
        onClose={closeMobileSearchOverlay}
      />

      {canEdit && (
        <EventListCreateDialog
          createOpen={createOpen}
          dateDay={dateDay}
          dateMonth={dateMonth}
          dateYear={dateYear}
          description={description}
          isPending={createMutation.isPending}
          locationId={locationId}
          metadataLocations={metadataLocations}
          sessionIndex={sessionIndex}
          onDateDayChange={setDateDay}
          onDateMonthChange={setDateMonth}
          onDateYearChange={setDateYear}
          onDescriptionChange={setDescription}
          onLocationIdChange={setLocationId}
          onOpenChange={setCreateOpen}
          onSessionIndexChange={setSessionIndex}
          onSubmit={submitCreateEvent}
          onTitleChange={setTitle}
          title={title}
        />
      )}
    </div>
  );
}
