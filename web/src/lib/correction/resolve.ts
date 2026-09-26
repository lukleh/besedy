import prisma from "@/lib/db";
import {
  isCorrectionEligibleRecording,
  listCorrectionEligibleHashes,
} from "@/lib/correction/eligibility";
import {
  resolvePublicationFilePath,
  resolveWorkspaceSourcePath,
} from "@/lib/correction/storage";

/**
 * There is no permissive "best transcript" resolver.
 *
 * Each consumer asks for its own rule by name, because the machine fallback
 * that search and MCP require must never quietly become a fallback for the
 * reading page.
 */

export type TranscriptSource =
  /** Serve the configured machine transcript, as today */
  | { kind: "machine" }
  /** Serve the published corrected snapshot from the corrections tree */
  | { kind: "publication"; workspaceId: string; publicationId: string }
  /** Correction-eligible but never published: the reader gets progress, not text */
  | { kind: "withheld"; workspaceId: string | null };

interface WorkspacePointers {
  id: string;
  readerPublicationId: string | null;
  searchPublicationId: string | null;
}

async function findWorkspacePointers(
  catalogId: string,
  audioHash: string
): Promise<WorkspacePointers | null> {
  return prisma.transcriptWorkspace.findFirst({
    where: { workflowGroupId: catalogId, audioHash, status: "ACTIVE" },
    select: {
      id: true,
      readerPublicationId: true,
      searchPublicationId: true,
    },
  });
}

/**
 * Reader page, ordinary transcript download and bulk export.
 *
 * The gate follows the **workspace**, not the current event assignment. Once
 * correction has started, this recording's transcript is the corrected one
 * whatever happens to its primary status afterwards — otherwise detaching a
 * recording, or promoting a different one, would silently replace a published
 * corrected transcript with the unchecked machine text underneath it, which is
 * the one thing this gate exists to prevent. Starting correction still
 * requires a primary recording; see `startWorkspace`.
 */
export async function resolveReaderTranscriptSource(
  catalogId: string,
  audioHash: string
): Promise<TranscriptSource> {
  // Deliberately blind to an activation in progress: the reader keeps the
  // snapshot it has until a publication has actually succeeded.
  const workspace = await findWorkspacePointers(catalogId, audioHash);

  if (workspace) {
    if (workspace.readerPublicationId) {
      return {
        kind: "publication",
        workspaceId: workspace.id,
        publicationId: workspace.readerPublicationId,
      };
    }
    return { kind: "withheld", workspaceId: workspace.id };
  }

  // No workspace: a recording in correction scope is waiting for one, and a
  // recording outside it keeps its configured machine transcript.
  if (!(await isCorrectionEligibleRecording(catalogId, audioHash))) {
    return { kind: "machine" };
  }

  return { kind: "withheld", workspaceId: null };
}

/**
 * Search and MCP.
 *
 * They keep the machine transcript until the first publication and keep the
 * last corrected snapshot after an ordinary unpublish, because an agent uses
 * transcription as a fallible source rather than as a document to sit and
 * read.
 */
export async function resolveSearchTranscriptSource(
  catalogId: string,
  audioHash: string
): Promise<TranscriptSource> {
  const workspace = await findWorkspacePointers(catalogId, audioHash);
  if (!workspace) return { kind: "machine" };

  // Only a publication whose index sync has finished counts. While one is
  // still activating, the index job is running and may yet roll back, so the
  // database pointer stays where it is (ADR 0006): search and MCP change
  // together, when the sync reports success.
  if (workspace.searchPublicationId) {
    return {
      kind: "publication",
      workspaceId: workspace.id,
      publicationId: workspace.searchPublicationId,
    };
  }

  return { kind: "machine" };
}

export type OriginalTranscriptSource =
  | { kind: "machine" }
  | { kind: "frozen"; workspaceId: string; backend: string };

/**
 * Privileged original access.
 *
 * Before a workspace exists this is the current configured default machine
 * transcript. Once correction has started it is always that workspace's frozen
 * source, before or after publication — and asking for it never starts a
 * workspace or changes one.
 */
export async function resolveOriginalTranscriptSource(
  catalogId: string,
  audioHash: string
): Promise<OriginalTranscriptSource> {
  const workspace = await prisma.transcriptWorkspace.findFirst({
    where: { workflowGroupId: catalogId, audioHash, status: "ACTIVE" },
    select: { id: true, sourceBackend: true },
  });

  if (!workspace) return { kind: "machine" };
  return {
    kind: "frozen",
    workspaceId: workspace.id,
    backend: workspace.sourceBackend,
  };
}

/** Bulk form for the catalog export, which asks about every visible hash. */
export async function resolveReaderTranscriptSources(
  catalogId: string,
  audioHashes: readonly string[]
): Promise<Map<string, TranscriptSource>> {
  const resolved = new Map<string, TranscriptSource>();
  if (audioHashes.length === 0) return resolved;

  // Workspaces first, for the same reason the single-recording resolver asks
  // about them first: a live workspace gates its recording whatever its
  // current event assignment says.
  const [eligible, workspaces] = await Promise.all([
    listCorrectionEligibleHashes(catalogId, audioHashes),
    prisma.transcriptWorkspace.findMany({
      where: {
        workflowGroupId: catalogId,
        audioHash: { in: [...audioHashes] },
        status: "ACTIVE",
      },
      select: { id: true, audioHash: true, readerPublicationId: true },
    }),
  ]);

  const workspaceByHash = new Map(
    workspaces.map((workspace) => [workspace.audioHash, workspace])
  );

  for (const audioHash of audioHashes) {
    const workspace = workspaceByHash.get(audioHash);

    if (workspace?.readerPublicationId) {
      resolved.set(audioHash, {
        kind: "publication",
        workspaceId: workspace.id,
        publicationId: workspace.readerPublicationId,
      });
      continue;
    }
    if (workspace) {
      resolved.set(audioHash, { kind: "withheld", workspaceId: workspace.id });
      continue;
    }
    resolved.set(
      audioHash,
      eligible.has(audioHash)
        ? { kind: "withheld", workspaceId: null }
        : { kind: "machine" }
    );
  }

  return resolved;
}

export function publicationArtifactPath(
  catalogId: string,
  source: Extract<TranscriptSource, { kind: "publication" }>,
  format: "json" | "txt" | "srt" | "vtt"
): string {
  return resolvePublicationFilePath(
    catalogId,
    source.workspaceId,
    source.publicationId,
    format
  );
}

export function frozenSourcePath(
  catalogId: string,
  source: Extract<OriginalTranscriptSource, { kind: "frozen" }>
): string {
  return resolveWorkspaceSourcePath(catalogId, source.workspaceId);
}
