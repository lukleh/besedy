import {
  isCorrectedTranscriptBackend,
  RESERVED_TRANSCRIPT_WORKFLOW_DIR,
} from "@/lib/correction/backend-key";

// Keep in sync with parse_transcript_components in besedy/core/paths_transcripts.py.
const LANGUAGE_SUFFIX = /@lang-(?:auto|[a-z]{2,3}(?:-[a-z]{2,3})?)$/;

/** The current machine directory contract, plus the reserved publication key. */
export function parseTranscriptBackendKey(
  backendKey: string
): { workflow: string; model: string } | null {
  const parts = backendKey.split("/");
  if (parts.length !== 2) return null;
  const [workflow, model] = parts;
  if (
    !workflow ||
    !model ||
    workflow === "." ||
    workflow === ".." ||
    model === "." ||
    model === ".." ||
    workflow.includes("\\") ||
    model.includes("\\")
  ) {
    return null;
  }

  if (workflow === RESERVED_TRANSCRIPT_WORKFLOW_DIR) {
    return isCorrectedTranscriptBackend(backendKey) ? { workflow, model } : null;
  }
  return LANGUAGE_SUFFIX.test(model) ? { workflow, model } : null;
}
