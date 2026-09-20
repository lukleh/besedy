import type { ASRTranscript, TranscriptFormat } from "@/lib/transcript";
import { CORRECTED_TRANSCRIPT_BACKEND } from "@/lib/correction/backend-key";
import {
  publicationArtifactPath,
  type TranscriptSource,
} from "@/lib/correction/resolve";
import { readJsonFile, readTextFile } from "@/lib/correction/storage";
import { computeProgress } from "@/lib/correction/workspace-service";
import type { CanonicalTranscript } from "@/lib/correction/source";

type PublicationSource = Extract<TranscriptSource, { kind: "publication" }>;

/** Published corrected transcripts always carry all four formats. */
export const PUBLISHED_TRANSCRIPT_FORMATS: TranscriptFormat[] = [
  "json",
  "txt",
  "srt",
  "vtt",
];

export async function loadPublishedTranscript(
  catalogId: string,
  audioHash: string,
  source: PublicationSource
): Promise<ASRTranscript | null> {
  const data = await readJsonFile<CanonicalTranscript>(
    publicationArtifactPath(catalogId, source, "json")
  );
  if (!data) return null;

  const meta = (data.meta ?? {}) as Record<string, unknown>;

  return {
    backend: CORRECTED_TRANSCRIPT_BACKEND,
    hash: audioHash,
    model: typeof meta.model === "string" ? meta.model : undefined,
    language: typeof data.language === "string" ? data.language : undefined,
    duration: typeof meta.duration === "number" ? meta.duration : undefined,
    segments: (data.segments ?? []).map((segment) => ({
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? 0),
      text: String(segment.text ?? ""),
      words: [],
    })),
  };
}

export async function readPublishedTranscriptFile(
  catalogId: string,
  source: PublicationSource,
  format: TranscriptFormat
): Promise<{ content: string; filename: string } | null> {
  const content = await readTextFile(
    publicationArtifactPath(catalogId, source, format)
  );
  if (content === null) return null;
  return { content, filename: `transcript.${format}` };
}

export interface ReaderCorrectionState {
  /** Whether anybody has started correcting this recording */
  started: boolean;
  spanCount: number;
  totalDurationSeconds: number;
  reviewedOnceDurationSeconds: number;
  fullyApprovedDurationSeconds: number;
  reviewedOnceRatio: number;
  fullyApprovedRatio: number;
}

/**
 * What a reader sees instead of an unpublished transcript: how far checking
 * has got, measured in audio rather than in spans, and nothing about who is
 * doing it or which passages are disputed.
 */
export async function getReaderCorrectionState(
  workspaceId: string | null
): Promise<ReaderCorrectionState> {
  if (!workspaceId) {
    return {
      started: false,
      spanCount: 0,
      totalDurationSeconds: 0,
      reviewedOnceDurationSeconds: 0,
      fullyApprovedDurationSeconds: 0,
      reviewedOnceRatio: 0,
      fullyApprovedRatio: 0,
    };
  }

  const progress = await computeProgress(workspaceId);
  const total = progress.totalDurationSeconds;

  return {
    started: true,
    spanCount: progress.spanCount,
    totalDurationSeconds: total,
    reviewedOnceDurationSeconds: progress.reviewedOnceDurationSeconds,
    fullyApprovedDurationSeconds: progress.fullyApprovedDurationSeconds,
    reviewedOnceRatio: total > 0 ? progress.reviewedOnceDurationSeconds / total : 0,
    fullyApprovedRatio: total > 0 ? progress.fullyApprovedDurationSeconds / total : 0,
  };
}
