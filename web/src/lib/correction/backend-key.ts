/**
 * The key the transcript API uses for a published corrected transcript.
 *
 * A corrected transcript is not another machine backend, but the transcript
 * API addresses text by backend key, so it needs a name here. It keeps the
 * `{workflow}/{model}` shape so every existing validator and path guard still
 * applies, and `corrected` is reserved as a workflow directory name so a real
 * backend can never claim it.
 */
export const CORRECTED_TRANSCRIPT_BACKEND = "corrected/published";

export const RESERVED_TRANSCRIPT_WORKFLOW_DIR = "corrected";

export function isCorrectedTranscriptBackend(backend: string): boolean {
  return backend === CORRECTED_TRANSCRIPT_BACKEND;
}
