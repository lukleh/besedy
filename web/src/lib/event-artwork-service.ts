import { createHash, randomUUID } from "crypto";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { logAuditEvent } from "@/lib/audit/logger";
import {
  getArtworkContentType,
  finalizeStagedEventArtworkAssetsRemoval,
  processArtworkAsset,
  readArtworkAsset,
  removeArtworkCandidateAssets,
  resolveEventArtworkAssetPath,
  restoreStagedEventArtworkAssets,
  stageArtworkCandidateAssetsRemoval,
  writeArtworkCandidateAssets,
  type ArtworkExtension,
  type ArtworkUploadInput,
  type ArtworkVariant,
  type StagedArtworkCandidateAssetsRemoval,
} from "@/lib/event-artwork-storage";

export class EventArtworkServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 404 | 409
  ) {
    super(message);
    this.name = "EventArtworkServiceError";
  }
}

const candidateSelect = {
  id: true,
  eventId: true,
  workflowGroupId: true,
  label: true,
  squareExtension: true,
  squareOriginalName: true,
  squareBytes: true,
  squareSha256: true,
  landscapeExtension: true,
  landscapeOriginalName: true,
  landscapeBytes: true,
  landscapeSha256: true,
  createdById: true,
  createdAt: true,
  createdBy: {
    select: { id: true, name: true, email: true },
  },
  publication: {
    select: { publishedAt: true, publishedById: true },
  },
} satisfies Prisma.CatalogEventArtworkSelect;

type CandidateRecord = Prisma.CatalogEventArtworkGetPayload<{
  select: typeof candidateSelect;
}>;

export interface EventArtworkCandidateView {
  id: string;
  eventId: number;
  label: string | null;
  createdAt: string;
  createdBy: { id: string; name: string | null; email: string | null } | null;
  published: boolean;
  publishedAt: string | null;
  assets: {
    square: {
      originalName: string;
      bytes: number;
      sha256: string;
    };
    landscape: {
      originalName: string;
      bytes: number;
      sha256: string;
    };
  };
}

export interface PublishedEventArtworkView {
  id: string;
  publishedAt: string;
  assets: {
    square: { bytes: number; sha256: string };
    landscape: { bytes: number; sha256: string };
  };
}

function toCandidateView(candidate: CandidateRecord): EventArtworkCandidateView {
  return {
    id: candidate.id,
    eventId: candidate.eventId,
    label: candidate.label,
    createdAt: candidate.createdAt.toISOString(),
    createdBy: candidate.createdBy,
    published: candidate.publication !== null,
    publishedAt: candidate.publication?.publishedAt.toISOString() ?? null,
    assets: {
      square: {
        originalName: candidate.squareOriginalName,
        bytes: candidate.squareBytes,
        sha256: candidate.squareSha256,
      },
      landscape: {
        originalName: candidate.landscapeOriginalName,
        bytes: candidate.landscapeBytes,
        sha256: candidate.landscapeSha256,
      },
    },
  };
}

async function requireEvent(catalogId: string, eventId: number): Promise<void> {
  const event = await prisma.catalogEvent.findFirst({
    where: { id: eventId, workflowGroupId: catalogId },
    select: { id: true },
  });
  if (!event) {
    throw new EventArtworkServiceError("Event not found", 404);
  }
}

async function lockEvent(tx: Prisma.TransactionClient, catalogId: string, eventId: number): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id
    FROM catalog_event
    WHERE id = ${eventId}
      AND workflow_group_id = ${catalogId}
    FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new EventArtworkServiceError("Event not found", 404);
  }
}

async function logArtworkAudit(options: {
  action: "EVENT_ARTWORK_CREATED" | "EVENT_ARTWORK_DELETED" | "EVENT_ARTWORK_PUBLISHED" | "EVENT_ARTWORK_UNPUBLISHED";
  userId: string;
  catalogId: string;
  eventId: number;
  artworkId: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await logAuditEvent({
    action: options.action,
    userId: options.userId,
    resource: "event_artwork",
    resourceId: options.artworkId,
    catalogId: options.catalogId,
    domain: "content",
    outcome: "changed",
    subjectType: "event_artwork",
    subjectId: options.artworkId,
    payload: {
      catalogId: options.catalogId,
      eventId: options.eventId,
      artworkId: options.artworkId,
      ...options.payload,
    },
    subjectSnapshot: {
      type: "event_artwork",
      id: options.artworkId,
      label: `Event ${options.eventId} artwork`,
      catalogId: options.catalogId,
    },
  });
}

export async function listEventArtworkCandidates(
  catalogId: string,
  eventId: number
): Promise<EventArtworkCandidateView[]> {
  await requireEvent(catalogId, eventId);
  const candidates = await prisma.catalogEventArtwork.findMany({
    where: { workflowGroupId: catalogId, eventId },
    select: candidateSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return candidates.map(toCandidateView);
}

export async function createEventArtworkCandidate(options: {
  catalogId: string;
  eventId: number;
  userId: string;
  label?: string | null;
  square: ArtworkUploadInput;
  landscape: ArtworkUploadInput;
}): Promise<EventArtworkCandidateView> {
  await requireEvent(options.catalogId, options.eventId);

  // Decode sequentially so one request cannot hold two maximum-size Sharp
  // pipelines at the same time.
  const square = await processArtworkAsset(options.square, "square");
  const landscape = await processArtworkAsset(options.landscape, "landscape");
  const artworkId = randomUUID();

  await writeArtworkCandidateAssets({
    catalogId: options.catalogId,
    eventId: options.eventId,
    artworkId,
    square,
    landscape,
  });

  let candidate: CandidateRecord;
  try {
    candidate = await prisma.catalogEventArtwork.create({
      data: {
        id: artworkId,
        workflowGroupId: options.catalogId,
        eventId: options.eventId,
        label: options.label?.trim().slice(0, 255) || null,
        squareExtension: square.extension,
        squareOriginalName: square.originalName,
        squareBytes: square.bytes.length,
        squareSha256: square.sha256,
        landscapeExtension: landscape.extension,
        landscapeOriginalName: landscape.originalName,
        landscapeBytes: landscape.bytes.length,
        landscapeSha256: landscape.sha256,
        createdById: options.userId,
      },
      select: candidateSelect,
    });
  } catch (error) {
    await removeArtworkCandidateAssets(options.catalogId, options.eventId, artworkId).catch(() => undefined);
    throw error;
  }

  await logArtworkAudit({
    action: "EVENT_ARTWORK_CREATED",
    userId: options.userId,
    catalogId: options.catalogId,
    eventId: options.eventId,
    artworkId,
    payload: {
      label: candidate.label,
      squareSha256: square.sha256,
      landscapeSha256: landscape.sha256,
    },
  });
  return toCandidateView(candidate);
}

export async function publishEventArtwork(options: {
  catalogId: string;
  eventId: number;
  artworkId: string;
  userId: string;
}): Promise<{ changed: boolean; previousArtworkId: string | null }> {
  const result = await prisma.$transaction(async (tx) => {
    await lockEvent(tx, options.catalogId, options.eventId);

    const candidate = await tx.catalogEventArtwork.findFirst({
      where: {
        id: options.artworkId,
        eventId: options.eventId,
        workflowGroupId: options.catalogId,
      },
      select: { id: true },
    });
    if (!candidate) {
      throw new EventArtworkServiceError("Artwork candidate not found", 404);
    }

    const current = await tx.catalogEventArtworkPublication.findUnique({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
      select: { artworkId: true },
    });
    if (current?.artworkId === options.artworkId) {
      return { changed: false, previousArtworkId: current.artworkId };
    }
    await tx.catalogEventArtworkPublication.upsert({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
      create: {
        workflowGroupId: options.catalogId,
        eventId: options.eventId,
        artworkId: options.artworkId,
        publishedById: options.userId,
      },
      update: {
        artworkId: options.artworkId,
        publishedById: options.userId,
        publishedAt: new Date(),
      },
    });
    return { changed: true, previousArtworkId: current?.artworkId ?? null };
  });

  if (result.changed) {
    await logArtworkAudit({
      action: "EVENT_ARTWORK_PUBLISHED",
      userId: options.userId,
      catalogId: options.catalogId,
      eventId: options.eventId,
      artworkId: options.artworkId,
      payload: { previousArtworkId: result.previousArtworkId },
    });
  }
  return result;
}

export async function unpublishEventArtwork(options: {
  catalogId: string;
  eventId: number;
  userId: string;
}): Promise<{ changed: boolean; previousArtworkId: string | null }> {
  const result = await prisma.$transaction(async (tx) => {
    await lockEvent(tx, options.catalogId, options.eventId);
    const current = await tx.catalogEventArtworkPublication.findUnique({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
      select: { artworkId: true },
    });
    if (!current) {
      return { changed: false, previousArtworkId: null };
    }
    await tx.catalogEventArtworkPublication.delete({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
    });
    return { changed: true, previousArtworkId: current.artworkId };
  });

  if (result.changed && result.previousArtworkId) {
    await logArtworkAudit({
      action: "EVENT_ARTWORK_UNPUBLISHED",
      userId: options.userId,
      catalogId: options.catalogId,
      eventId: options.eventId,
      artworkId: result.previousArtworkId,
    });
  }
  return result;
}

export async function deleteEventArtworkCandidate(options: {
  catalogId: string;
  eventId: number;
  artworkId: string;
  userId: string;
}): Promise<void> {
  let stagedAssets: StagedArtworkCandidateAssetsRemoval | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      await lockEvent(tx, options.catalogId, options.eventId);
      const candidate = await tx.catalogEventArtwork.findFirst({
        where: {
          id: options.artworkId,
          eventId: options.eventId,
          workflowGroupId: options.catalogId,
        },
        select: { id: true, publication: { select: { artworkId: true } } },
      });
      if (!candidate) {
        throw new EventArtworkServiceError("Artwork candidate not found", 404);
      }
      if (candidate.publication) {
        throw new EventArtworkServiceError("Published artwork must be unpublished before deletion", 409);
      }
      stagedAssets = await stageArtworkCandidateAssetsRemoval(options.catalogId, options.eventId, options.artworkId);
      await tx.catalogEventArtwork.delete({ where: { id: options.artworkId } });
    });
  } catch (error) {
    if (stagedAssets) {
      await restoreStagedEventArtworkAssets(stagedAssets);
    }
    throw error;
  }

  await logArtworkAudit({
    action: "EVENT_ARTWORK_DELETED",
    userId: options.userId,
    catalogId: options.catalogId,
    eventId: options.eventId,
    artworkId: options.artworkId,
  });
  if (stagedAssets) {
    await finalizeStagedEventArtworkAssetsRemoval(stagedAssets).catch((error) => {
      console.error("Failed to finalize artwork candidate cleanup:", error);
    });
  }
}

async function findArtworkAssetRecord(options: {
  catalogId: string;
  eventId: number;
  artworkId?: string;
  publishedOnly: boolean;
}) {
  if (options.publishedOnly) {
    const publication = await prisma.catalogEventArtworkPublication.findUnique({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
      select: {
        artwork: {
          select: {
            id: true,
            squareExtension: true,
            landscapeExtension: true,
          },
        },
      },
    });
    return publication?.artwork ?? null;
  }

  if (!options.artworkId) return null;
  return prisma.catalogEventArtwork.findFirst({
    where: {
      id: options.artworkId,
      workflowGroupId: options.catalogId,
      eventId: options.eventId,
    },
    select: {
      id: true,
      squareExtension: true,
      landscapeExtension: true,
    },
  });
}

export async function loadEventArtworkAsset(options: {
  catalogId: string;
  eventId: number;
  artworkId?: string;
  variant: ArtworkVariant;
  publishedOnly: boolean;
}): Promise<{
  bytes: Buffer;
  contentType: string;
  artworkId: string;
  sha256: string;
} | null> {
  const artwork = await findArtworkAssetRecord(options);
  if (!artwork) return null;
  const extension = (
    options.variant === "square" ? artwork.squareExtension : artwork.landscapeExtension
  ) as ArtworkExtension;
  const filePath = resolveEventArtworkAssetPath(
    options.catalogId,
    options.eventId,
    artwork.id,
    options.variant,
    extension
  );
  const asset = await readArtworkAsset(filePath);
  if (!asset) return null;
  return {
    bytes: asset.bytes,
    contentType: getArtworkContentType(extension),
    artworkId: artwork.id,
    sha256: createAssetEtag(asset.bytes),
  };
}

function createAssetEtag(bytes: Buffer): string {
  // A strong digest keeps conditional requests stable for immutable candidate
  // bytes without exposing filesystem metadata.
  return createHash("sha256").update(bytes).digest("hex");
}

export async function getPublishedEventArtwork(
  catalogId: string,
  eventId: number
): Promise<PublishedEventArtworkView | null> {
  const publication = await prisma.catalogEventArtworkPublication.findUnique({
    where: {
      workflowGroupId_eventId: { workflowGroupId: catalogId, eventId },
    },
    select: {
      publishedAt: true,
      artwork: {
        select: {
          id: true,
          squareBytes: true,
          squareSha256: true,
          landscapeBytes: true,
          landscapeSha256: true,
        },
      },
    },
  });
  if (!publication) return null;
  return {
    id: publication.artwork.id,
    publishedAt: publication.publishedAt.toISOString(),
    assets: {
      square: {
        bytes: publication.artwork.squareBytes,
        sha256: publication.artwork.squareSha256,
      },
      landscape: {
        bytes: publication.artwork.landscapeBytes,
        sha256: publication.artwork.landscapeSha256,
      },
    },
  };
}

export interface LatestEventArtworkCandidateView {
  id: string;
  label: string | null;
  createdAt: string;
}

export async function getLatestEventArtworkCandidate(
  catalogId: string,
  eventId: number
): Promise<LatestEventArtworkCandidateView | null> {
  const candidate = await prisma.catalogEventArtwork.findFirst({
    where: { workflowGroupId: catalogId, eventId },
    select: { id: true, label: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!candidate) return null;
  return {
    id: candidate.id,
    label: candidate.label,
    createdAt: candidate.createdAt.toISOString(),
  };
}

export type ArtworkWorkflowStatus = "none" | "draft-only" | "published" | "published-with-newer-drafts";

export async function getEventArtworkWorkflowStatuses(
  catalogId: string,
  eventIds: number[]
): Promise<Map<number, ArtworkWorkflowStatus>> {
  const result = new Map<number, ArtworkWorkflowStatus>();
  for (const eventId of eventIds) result.set(eventId, "none");
  if (eventIds.length === 0) return result;

  const candidates = await prisma.catalogEventArtwork.findMany({
    where: { workflowGroupId: catalogId, eventId: { in: eventIds } },
    select: { eventId: true, createdAt: true },
  });
  const publications = await prisma.catalogEventArtworkPublication.findMany({
    where: { workflowGroupId: catalogId, eventId: { in: eventIds } },
    select: { eventId: true, publishedAt: true },
  });
  const publicationByEvent = new Map(publications.map((publication) => [publication.eventId, publication]));
  const latestCandidateByEvent = new Map<number, Date>();
  for (const candidate of candidates) {
    const latest = latestCandidateByEvent.get(candidate.eventId);
    if (!latest || candidate.createdAt > latest) {
      latestCandidateByEvent.set(candidate.eventId, candidate.createdAt);
    }
  }

  for (const eventId of eventIds) {
    const latestCandidate = latestCandidateByEvent.get(eventId);
    const publication = publicationByEvent.get(eventId);
    if (!publication) {
      result.set(eventId, latestCandidate ? "draft-only" : "none");
      continue;
    }
    result.set(
      eventId,
      latestCandidate && latestCandidate > publication.publishedAt ? "published-with-newer-drafts" : "published"
    );
  }
  return result;
}
