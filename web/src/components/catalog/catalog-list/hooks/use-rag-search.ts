"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent,
} from "react";
import { useTranslations } from "next-intl";
import { fetchJson, ApiError } from "@/lib/api/fetch-json";

const RAG_SEARCH_SESSION_PREFIX = "besedy-rag-search-";

function parseStoredRagQuery(raw: string, sessionKey: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { query?: unknown };
    return typeof parsed.query === "string" ? parsed.query.trim() : "";
  } catch (error) {
    console.warn("Ignoring malformed RAG session state", {
      sessionKey,
      error,
    });
    return null;
  }
}

export interface RagSearchResult {
  rank: number;
  audioHash: string;
  chunkId: string;
  score: number;
  startSec: number;
  endSec: number;
  text: string;
  contextText: string;
  contextStartSec: number;
  contextEndSec: number;
  neighbors: {
    before: Array<{
      chunkId: string;
      audioHash: string;
      startSec: number;
      endSec: number;
      text: string;
    }>;
    after: Array<{
      chunkId: string;
      audioHash: string;
      startSec: number;
      endSec: number;
      text: string;
    }>;
  };
  metadata: {
    date: {
      year: number | null;
      month: number | null;
      day: number | null;
    } | null;
    location: { id: number; name: string } | null;
    recorder: { id: number; name: string } | null;
  };
  citation: {
    audioHash: string;
    chunkId: string;
    startSec: number;
    endSec: number;
    workflowGroupId: string;
    backendKey: string;
    chunkVersion: string;
  };
  provenance: {
    workflowGroupId: string;
    backendKey: string;
    runId: string;
    chunkVersion: string;
    embeddingModel: string;
    embeddingModelVersion: string;
  };
}

interface RagSearchResponse {
  query: string;
  results: RagSearchResult[];
}

export interface UseRagSearchOptions {
  activeCatalogId: string | null;
  canUseRagSearch: boolean;
  sessionScope?: string;
  /** Must be true once initial data has loaded (triggers session restore). */
  dataLoaded: boolean;
  /** Called when a saved RAG session query is restored. */
  onSessionRestore?: (query: string) => void;
}

export function useRagSearch({
  activeCatalogId,
  canUseRagSearch,
  sessionScope,
  dataLoaded,
  onSessionRestore,
}: UseRagSearchOptions) {
  const t = useTranslations("catalog");

  const [ragQuery, setRagQuery] = useState("");
  const [ragSubmittedQuery, setRagSubmittedQuery] = useState("");
  const [ragResults, setRagResults] = useState<RagSearchResult[]>([]);
  const [ragLoading, setRagLoading] = useState(false);
  const [ragError, setRagError] = useState<string | null>(null);
  const [isRagMode, setIsRagMode] = useState(false);
  const ragRequestIdRef = useRef(0);
  const ragRestoreDoneRef = useRef(false);

  const ragSessionKey = activeCatalogId
    ? `${RAG_SEARCH_SESSION_PREFIX}${activeCatalogId}${sessionScope ? `-${sessionScope}` : ""}`
    : null;

  const executeRagSearch = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      if (!query || !activeCatalogId || !canUseRagSearch) return;

      const requestId = ++ragRequestIdRef.current;
      setRagLoading(true);
      setRagError(null);
      setIsRagMode(true);
      setRagSubmittedQuery(query);

      try {
        const response = await fetchJson<RagSearchResponse>(
          `/api/catalogs/${activeCatalogId}/search`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
          },
        );

        if (requestId !== ragRequestIdRef.current) return;
        const results = Array.isArray(response.results) ? response.results : [];
        setRagResults(results);
        setRagError(null);
        if (ragSessionKey) {
          sessionStorage.setItem(ragSessionKey, JSON.stringify({ query }));
        }
      } catch (error) {
        if (requestId !== ragRequestIdRef.current) return;
        const message =
          error instanceof ApiError
            ? error.message
            : t("ragSearch.errorDefault");
        setRagError(message);
        setRagResults([]);
      } finally {
        if (requestId === ragRequestIdRef.current) {
          setRagLoading(false);
        }
      }
    },
    [activeCatalogId, canUseRagSearch, ragSessionKey, t],
  );

  const exitRagMode = useCallback(
    (clearQuery: boolean) => {
      ragRequestIdRef.current += 1;
      setIsRagMode(false);
      setRagLoading(false);
      setRagError(null);
      setRagResults([]);
      setRagSubmittedQuery("");
      if (clearQuery) setRagQuery("");
      if (ragSessionKey) {
        sessionStorage.removeItem(ragSessionKey);
      }
    },
    [ragSessionKey],
  );

  const hideRagMode = useCallback(() => {
    setIsRagMode(false);
  }, []);

  const handleRagSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void executeRagSearch(ragQuery);
    },
    [executeRagSearch, ragQuery],
  );

  // Stable refs to avoid callback identity in effect deps.
  const exitRagModeRef = useRef(exitRagMode);
  exitRagModeRef.current = exitRagMode;
  const executeRagSearchRef = useRef(executeRagSearch);
  executeRagSearchRef.current = executeRagSearch;
  const onSessionRestoreRef = useRef(onSessionRestore);
  onSessionRestoreRef.current = onSessionRestore;

  // Reset state on catalog change.
  // Keep this effect before the restore effect so restored state is not
  // immediately cleared when both effects run in the same commit.
  useEffect(() => {
    ragRestoreDoneRef.current = false;
    setRagQuery("");
    setRagSubmittedQuery("");
    setRagResults([]);
    setRagError(null);
    setRagLoading(false);
    setIsRagMode(false);
  }, [activeCatalogId]);

  // Session restore — depends only on trigger values, not callback identities.
  useEffect(() => {
    if (!dataLoaded) return;
    if (!canUseRagSearch) {
      exitRagModeRef.current(true);
      return;
    }
    if (!ragSessionKey || ragRestoreDoneRef.current) return;

    ragRestoreDoneRef.current = true;
    const raw = sessionStorage.getItem(ragSessionKey);
    if (!raw) return;
    const savedQuery = parseStoredRagQuery(raw, ragSessionKey);
    if (!savedQuery) return;
    onSessionRestoreRef.current?.(savedQuery);
    setRagQuery(savedQuery);
    void executeRagSearchRef.current(savedQuery);
  }, [dataLoaded, canUseRagSearch, ragSessionKey]);

  return {
    ragQuery,
    setRagQuery,
    ragSubmittedQuery,
    ragResults,
    ragLoading,
    ragError,
    isRagMode,
    executeRagSearch,
    hideRagMode,
    exitRagMode,
    handleRagSubmit,
  };
}
