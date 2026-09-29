import { getRagBackendKey } from "@/lib/runtime-config";

/**
 * The machine transcript every consumer reads by default.
 *
 * ADR 0006 names one default for the reader, the freeze, search, MCP and bulk
 * export: the search backend in `RAG_BACKEND_KEY`. The priority order supplies
 * the fallback when a recording lacks that backend's transcript, in which case
 * the recording is absent from the search index too.
 */
export function selectDefaultTranscriptBackend(
  orderedBackends: readonly string[]
): string | null {
  const configured = getRagBackendKey();
  if (orderedBackends.includes(configured)) return configured;
  return orderedBackends[0] ?? null;
}
