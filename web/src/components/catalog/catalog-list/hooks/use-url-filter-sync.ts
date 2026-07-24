"use client";

import { useEffect, useRef } from "react";
import { normalizeEnumFilter } from "../utils";

interface UrlFilterValues {
  recorder?: string;
  location?: string;
  album?: string;
}

interface UseUrlFilterSyncOptions {
  searchKey: string;
  filtersReady: boolean;
  setRecorderFilter: (value: string) => void;
  setLocationFilter: (value: string) => void;
  setAlbumFilter: (value: string) => void;
}

export function useUrlFilterSync({
  searchKey,
  filtersReady,
  setRecorderFilter,
  setLocationFilter,
  setAlbumFilter,
}: UseUrlFilterSyncOptions) {
  const urlFiltersAppliedRef = useRef<string | null>(null);
  const urlFilterValuesRef = useRef<UrlFilterValues | null>(null);

  useEffect(() => {
    if (!filtersReady) return;

    const params = new URLSearchParams(searchKey);
    const recorderParam = normalizeEnumFilter(params.get("recorder"));
    const locationParam = normalizeEnumFilter(params.get("location"));
    const albumParam = normalizeEnumFilter(params.get("album"));
    const nextKey = `${recorderParam ?? ""}|${locationParam ?? ""}|${albumParam ?? ""}`;

    if (!recorderParam && !locationParam && !albumParam) {
      urlFiltersAppliedRef.current = null;
      urlFilterValuesRef.current = null;
      return;
    }

    if (urlFiltersAppliedRef.current === nextKey) return;

    urlFilterValuesRef.current = {
      recorder: recorderParam ?? undefined,
      location: locationParam ?? undefined,
      album: albumParam ?? undefined,
    };

    if (recorderParam) {
      setRecorderFilter(recorderParam);
    }
    if (locationParam) {
      setLocationFilter(locationParam);
    }
    if (albumParam) {
      setAlbumFilter(albumParam);
    }

    urlFiltersAppliedRef.current = nextKey;
  }, [
    filtersReady,
    searchKey,
    setAlbumFilter,
    setLocationFilter,
    setRecorderFilter,
  ]);

  return {
    urlFilterValuesRef,
  };
}
