import { getRagBackendKey } from "@/lib/runtime-config";

/**
 * The machine transcript every consumer reads by default.
 *
 * ADR 0006 names one default for the reader, the freeze, search, MCP and bulk
 * export: the search backend in `RAG_BACKEND_KEY`. Its legacy spelling without
 * the `@lang-…` suffix is accepted for transcript trees that predate the
 * suffix. The priority order callers pass in only supplies the fallback when a
 * recording lacks that backend's transcript, in which case the recording is
 * absent from the search index too.
 */
export function selectDefaultTranscriptBackend(
  orderedBackends: readonly string[]
): string | null {
  const configured = getRagBackendKey();
  const legacy = configured.replace(/@lang-[^/@]+$/, "");
  const candidates = legacy === configured ? [configured] : [configured, legacy];
  for (const candidate of candidates) {
    if (orderedBackends.includes(candidate)) return candidate;
  }
  return orderedBackends[0] ?? null;
}
