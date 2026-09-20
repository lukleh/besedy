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
  /** An activation that has written its artifacts but not yet moved the pointers */
  publications: { id: string }[];
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
      publications: {
        where: { status: "ACTIVATING" },
        select: { id: true },
        orderBy: { activatingAt: "desc" },
        take: 1,
      },
    },
  });
}

/** Reader page, ordinary transcript download and bulk export. */
export async function resolveReaderTranscriptSource(
  catalogId: string,
  audioHash: string
): Promise<TranscriptSource> {
  if (!(await isCorrectionEligibleRecording(catalogId, audioHash))) {
    return { kind: "machine" };
  }

  // Deliberately blind to an activation in progress: the reader keeps the
  // snapshot it has until a publication has actually succeeded.
  const workspace = await findWorkspacePointers(catalogId, audioHash);
  if (workspace?.readerPublicationId) {
    return {
      kind: "publication",
      workspaceId: workspace.id,
      publicationId: workspace.readerPublicationId,
    };
  }

  return { kind: "withheld", workspaceId: workspace?.id ?? null };
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

  // An activation writes its artifacts and publishes the index pointer before
  // it moves these database pointers, so between those two steps the index
  // already serves the new text. Resolving an activating publication first is
  // what keeps this side from contradicting it — an agent asked to verify a
  // search hit by replaying the passage would otherwise get the machine
  // wording back. After a crash mid-activation that window lasts until
  // reconciliation, not milliseconds.
  const activating = workspace.publications[0]?.id;
  if (activating) {
    return {
      kind: "publication",
      workspaceId: workspace.id,
      publicationId: activating,
    };
  }

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

  const eligible = await listCorrectionEligibleHashes(catalogId, audioHashes);
  const workspaces =
    eligible.size === 0
      ? []
      : await prisma.transcriptWorkspace.findMany({
          where: {
            workflowGroupId: catalogId,
            audioHash: { in: [...eligible] },
            status: "ACTIVE",
          },
          select: { id: true, audioHash: true, readerPublicationId: true },
        });

  const workspaceByHash = new Map(
    workspaces.map((workspace) => [workspace.audioHash, workspace])
  );

  for (const audioHash of audioHashes) {
    if (!eligible.has(audioHash)) {
      resolved.set(audioHash, { kind: "machine" });
      continue;
    }
    const workspace = workspaceByHash.get(audioHash);
    if (workspace?.readerPublicationId) {
      resolved.set(audioHash, {
        kind: "publication",
        workspaceId: workspace.id,
        publicationId: workspace.readerPublicationId,
      });
    } else {
      resolved.set(audioHash, { kind: "withheld", workspaceId: workspace?.id ?? null });
    }
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
