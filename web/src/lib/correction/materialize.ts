import type { CanonicalTranscript } from "@/lib/correction/source";
import type { RenderableSegment } from "@/lib/correction/render";

/** Provenance block added to a published corrected transcript. */
export interface CorrectionProvenance {
  schema_version: number;
  workspace_id: string;
  publication_id: string;
  source_fingerprint: string;
  published_at: string;
  required_approvals: number;
}

export const CORRECTION_PROVENANCE_SCHEMA_VERSION = 1;

/**
 * Summary fields derived from the machine text. Copying them across would
 * describe the transcript that was replaced, so they are recomputed or
 * dropped.
 */
const DERIVED_META_FIELDS = ["transcript_text", "num_segments", "num_words"] as const;

/** Per-segment machine detail that no longer describes the published text. */
const DERIVED_SEGMENT_FIELDS = [
  "words",
  "confidence",
  "avg_logprob",
  "no_speech_prob",
  "compression_ratio",
  "temperature",
  "tokens",
  "seek",
] as const;

export interface MaterializeInput {
  source: CanonicalTranscript;
  segments: readonly RenderableSegment[];
  provenance: CorrectionProvenance;
}

/**
 * Build the canonical JSON for one publication.
 *
 * It stays a valid canonical transcript and keeps the honest source facts —
 * the backend and model that produced the text underneath, the recording
 * duration, the generation parameters — because pretending a human wrote it
 * from nothing would lose the provenance. What it does not keep is any
 * summary the machine computed about words it no longer contains.
 */
export function materializeCorrectedTranscript(
  input: MaterializeInput
): Record<string, unknown> {
  const sourceMeta = { ...(input.source.meta ?? {}) } as Record<string, unknown>;
  for (const field of DERIVED_META_FIELDS) {
    delete sourceMeta[field];
  }

  const segments = input.segments.map((segment) => {
    const published: Record<string, unknown> = {
      start: segment.start,
      end: segment.end,
      text: segment.text,
      // v1 corrects text only, so there is no per-word timing to carry and no
      // machine confidence that still applies. The reader already falls back
      // to whole-segment highlighting when the word array is empty.
      confidence: null,
      words: [],
    };
    return published;
  });

  const transcriptText = input.segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();

  const result: Record<string, unknown> = {
    ...input.source,
    meta: {
      ...sourceMeta,
      transcript_text: transcriptText,
      num_segments: segments.length,
      correction: input.provenance,
    },
    segments,
  };

  // `num_words` is omitted rather than guessed: v1 carries no timed word
  // arrays and counting words is language-dependent.
  return result;
}

/** Strip machine detail from a segment shape, for callers comparing sources. */
export function stripDerivedSegmentFields(
  segment: Record<string, unknown>
): Record<string, unknown> {
  const copy = { ...segment };
  for (const field of DERIVED_SEGMENT_FIELDS) {
    delete copy[field];
  }
  return copy;
}
