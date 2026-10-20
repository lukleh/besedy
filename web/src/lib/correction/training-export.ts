import prisma from "@/lib/db";
import { loadSpanFlags } from "@/lib/correction/flag-service";
import { loadSpanSummaries } from "@/lib/correction/span-summaries";

/**
 * What corrected text can train a model (ADR 0012).
 *
 * The unit of training is the decoded chunk: its audio is exactly what the
 * model was given, and the texts of its spans, in order, are the label. This
 * module decides which chunks qualify and returns everything the Python
 * dataset builder needs to rebuild them, including the excluded chunks and
 * why, so an export can be audited and rebuilt from the revision IDs it lists.
 *
 * Eligibility is export policy, not stored state, and may change: today a
 * chunk qualifies when every span is done, no span carries a flag, and every
 * approval that makes a span done reports at least `minHeardFraction` of the
 * span heard.
 */

export const TRAINING_EXPORT_SCHEMA_VERSION = 1;

export interface TrainingExportPolicy {
  minHeardFraction: number;
}

export const DEFAULT_TRAINING_EXPORT_POLICY: TrainingExportPolicy = { minHeardFraction: 0.9 };

export interface TrainingExportSpan {
  spanId: string;
  ordinal: number;
  revisionId: string;
  text: string;
  firstRegion: number;
  lastRegion: number;
}

export interface TrainingExportChunk {
  chunk: number;
  eligible: boolean;
  /** Why an excluded chunk is excluded; empty for an eligible one */
  reasons: string[];
  spans: TrainingExportSpan[];
}

export interface TrainingExportWorkspace {
  workspaceId: string;
  audioHash: string;
  sourceBackend: string;
  sourceFingerprint: string;
  segmentationVersion: string;
  stagedAudio: { path: string; size: number; sha256: string };
  chunks: TrainingExportChunk[];
}

export interface TrainingExport {
  schemaVersion: number;
  exportedAt: string;
  catalogId: string;
  policy: TrainingExportPolicy;
  workspaces: TrainingExportWorkspace[];
}

/** The latest playback each approver reported on the given revisions. */
async function approvalPlayback(
  revisionIds: readonly string[]
): Promise<Map<string, Map<string, number | null>>> {
  const result = new Map<string, Map<string, number | null>>();
  if (revisionIds.length === 0) return result;
  const decisions = await prisma.transcriptSpanDecision.findMany({
    where: { revisionId: { in: [...revisionIds] }, kind: "APPROVE" },
    orderBy: { sequence: "asc" },
    select: { revisionId: true, actorKey: true, heardFraction: true },
  });
  for (const decision of decisions) {
    const byActor = result.get(decision.revisionId) ?? new Map<string, number | null>();
    byActor.set(decision.actorKey, decision.heardFraction);
    result.set(decision.revisionId, byActor);
  }
  return result;
}

export async function buildTrainingExport(
  catalogId: string,
  policy: TrainingExportPolicy = DEFAULT_TRAINING_EXPORT_POLICY
): Promise<TrainingExport> {
  const workspaces = await prisma.transcriptWorkspace.findMany({
    where: { workflowGroupId: catalogId, status: "ACTIVE", segmentationVersion: { not: null } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      audioHash: true,
      sourceBackend: true,
      sourceFingerprint: true,
      segmentationVersion: true,
      stagedAudioPath: true,
      stagedAudioSize: true,
      stagedAudioSha256: true,
    },
  });

  const exported: TrainingExportWorkspace[] = [];
  for (const workspace of workspaces) {
    const summaries = await loadSpanSummaries(workspace.id);
    const regions = await prisma.transcriptSpan.findMany({
      where: { workspaceId: workspace.id },
      select: { id: true, chunkOrdinal: true, firstRegionIndex: true, lastRegionIndex: true },
    });
    const regionsBySpan = new Map(regions.map((row) => [row.id, row]));
    const flags = await loadSpanFlags(summaries.map((span) => span.id));
    const playback = await approvalPlayback(
      summaries.flatMap((span) => (span.currentRevision ? [span.currentRevision.id] : []))
    );

    const chunks = new Map<number, TrainingExportChunk>();
    for (const span of summaries) {
      const placement = regionsBySpan.get(span.id);
      if (!placement || placement.chunkOrdinal === null || !span.currentRevision) continue;
      const chunk = chunks.get(placement.chunkOrdinal) ?? {
        chunk: placement.chunkOrdinal,
        eligible: true,
        reasons: [],
        spans: [],
      };
      chunk.spans.push({
        spanId: span.id,
        ordinal: span.ordinal,
        revisionId: span.currentRevision.id,
        text: span.currentRevision.text,
        firstRegion: placement.firstRegionIndex ?? 0,
        lastRegion: placement.lastRegionIndex ?? 0,
      });

      const reasons: string[] = [];
      if (span.summary.state !== "done") reasons.push(`span ${span.ordinal} is ${span.summary.state}`);
      const spanFlags = flags.get(span.id) ?? [];
      if (spanFlags.length > 0) {
        reasons.push(`span ${span.ordinal} is flagged ${spanFlags.map((flag) => flag.kind).join(", ")}`);
      }
      const heard = playback.get(span.currentRevision.id);
      for (const approver of span.summary.approverIds) {
        const fraction = heard?.get(approver) ?? null;
        if (fraction === null || fraction < policy.minHeardFraction) {
          reasons.push(`span ${span.ordinal} has an approval without listening`);
          break;
        }
      }
      if (reasons.length > 0) {
        chunk.eligible = false;
        chunk.reasons.push(...reasons);
      }
      chunks.set(placement.chunkOrdinal, chunk);
    }

    exported.push({
      workspaceId: workspace.id,
      audioHash: workspace.audioHash,
      sourceBackend: workspace.sourceBackend,
      sourceFingerprint: workspace.sourceFingerprint,
      segmentationVersion: workspace.segmentationVersion ?? "",
      stagedAudio: {
        path: workspace.stagedAudioPath ?? "",
        size: Number(workspace.stagedAudioSize ?? 0),
        sha256: workspace.stagedAudioSha256 ?? "",
      },
      chunks: [...chunks.values()].sort((a, b) => a.chunk - b.chunk),
    });
  }

  return {
    schemaVersion: TRAINING_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    catalogId,
    policy,
    workspaces: exported,
  };
}
