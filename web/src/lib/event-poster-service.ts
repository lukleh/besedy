import { createHash, randomUUID } from "crypto";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { logAuditEvent } from "@/lib/audit/logger";
import {
  getPosterContentType,
  finalizeStagedEventPosterAssetsRemoval,
  processPosterAsset,
  readPosterAsset,
  removePosterCandidateAssets,
  resolveEventPosterAssetPath,
  restoreStagedEventPosterAssets,
  stagePosterCandidateAssetsRemoval,
  writePosterCandidateAssets,
  type PosterExtension,
  type PosterUploadInput,
  type PosterVariant,
  type StagedPosterCandidateAssetsRemoval,
} from "@/lib/event-poster-storage";

export class EventPosterServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 404 | 409
  ) {
    super(message);
    this.name = "EventPosterServiceError";
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
} satisfies Prisma.CatalogEventPosterSelect;

type CandidateRecord = Prisma.CatalogEventPosterGetPayload<{
  select: typeof candidateSelect;
}>;

export interface EventPosterCandidateView {
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

export interface PublishedEventPosterView {
  id: string;
  publishedAt: string;
  assets: {
    square: { bytes: number; sha256: string };
    landscape: { bytes: number; sha256: string };
  };
}

function toCandidateView(candidate: CandidateRecord): EventPosterCandidateView {
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
    throw new EventPosterServiceError("Event not found", 404);
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
    throw new EventPosterServiceError("Event not found", 404);
  }
}

async function logPosterAudit(options: {
  action: "EVENT_POSTER_CREATED" | "EVENT_POSTER_DELETED" | "EVENT_POSTER_PUBLISHED" | "EVENT_POSTER_UNPUBLISHED";
  userId: string;
  catalogId: string;
  eventId: number;
  posterId: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await logAuditEvent({
    action: options.action,
    userId: options.userId,
    resource: "event_poster",
    resourceId: options.posterId,
    catalogId: options.catalogId,
    domain: "content",
    outcome: "changed",
    subjectType: "event_poster",
    subjectId: options.posterId,
    payload: {
      catalogId: options.catalogId,
      eventId: options.eventId,
      posterId: options.posterId,
      ...options.payload,
    },
    subjectSnapshot: {
      type: "event_poster",
      id: options.posterId,
      label: `Event ${options.eventId} poster`,
      catalogId: options.catalogId,
    },
  });
}

export async function listEventPosterCandidates(
  catalogId: string,
  eventId: number
): Promise<EventPosterCandidateView[]> {
  await requireEvent(catalogId, eventId);
  const candidates = await prisma.catalogEventPoster.findMany({
    where: { workflowGroupId: catalogId, eventId },
    select: candidateSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return candidates.map(toCandidateView);
}

export async function createEventPosterCandidate(options: {
  catalogId: string;
  eventId: number;
  userId: string;
  label?: string | null;
  square: PosterUploadInput;
  landscape: PosterUploadInput;
}): Promise<EventPosterCandidateView> {
  await requireEvent(options.catalogId, options.eventId);

  // Decode sequentially so one request cannot hold two maximum-size Sharp
  // pipelines at the same time.
  const square = await processPosterAsset(options.square, "square");
  const landscape = await processPosterAsset(options.landscape, "landscape");
  const posterId = randomUUID();

  await writePosterCandidateAssets({
    catalogId: options.catalogId,
    eventId: options.eventId,
    posterId,
    square,
    landscape,
  });

  let candidate: CandidateRecord;
  try {
    candidate = await prisma.catalogEventPoster.create({
      data: {
        id: posterId,
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
    await removePosterCandidateAssets(options.catalogId, options.eventId, posterId).catch(() => undefined);
    throw error;
  }

  await logPosterAudit({
    action: "EVENT_POSTER_CREATED",
    userId: options.userId,
    catalogId: options.catalogId,
    eventId: options.eventId,
    posterId,
    payload: {
      label: candidate.label,
      squareSha256: square.sha256,
      landscapeSha256: landscape.sha256,
    },
  });
  return toCandidateView(candidate);
}

export async function publishEventPoster(options: {
  catalogId: string;
  eventId: number;
  posterId: string;
  userId: string;
  replaceExisting?: boolean;
}): Promise<{ changed: boolean; previousPosterId: string | null }> {
  const result = await prisma.$transaction(async (tx) => {
    await lockEvent(tx, options.catalogId, options.eventId);

    const candidate = await tx.catalogEventPoster.findFirst({
      where: {
        id: options.posterId,
        eventId: options.eventId,
        workflowGroupId: options.catalogId,
      },
      select: { id: true },
    });
    if (!candidate) {
      throw new EventPosterServiceError("Poster candidate not found", 404);
    }

    const current = await tx.catalogEventPosterPublication.findUnique({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
      select: { posterId: true },
    });
    if (current?.posterId === options.posterId) {
      return { changed: false, previousPosterId: current.posterId };
    }
    if (current && options.replaceExisting === false) {
      return { changed: false, previousPosterId: current.posterId };
    }

    await tx.catalogEventPosterPublication.upsert({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
      create: {
        workflowGroupId: options.catalogId,
        eventId: options.eventId,
        posterId: options.posterId,
        publishedById: options.userId,
      },
      update: {
        posterId: options.posterId,
        publishedById: options.userId,
        publishedAt: new Date(),
      },
    });
    return { changed: true, previousPosterId: current?.posterId ?? null };
  });

  if (result.changed) {
    await logPosterAudit({
      action: "EVENT_POSTER_PUBLISHED",
      userId: options.userId,
      catalogId: options.catalogId,
      eventId: options.eventId,
      posterId: options.posterId,
      payload: { previousPosterId: result.previousPosterId },
    });
  }
  return result;
}

export async function unpublishEventPoster(options: {
  catalogId: string;
  eventId: number;
  userId: string;
}): Promise<{ changed: boolean; previousPosterId: string | null }> {
  const result = await prisma.$transaction(async (tx) => {
    await lockEvent(tx, options.catalogId, options.eventId);
    const current = await tx.catalogEventPosterPublication.findUnique({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
      select: { posterId: true },
    });
    if (!current) {
      return { changed: false, previousPosterId: null };
    }
    await tx.catalogEventPosterPublication.delete({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
    });
    return { changed: true, previousPosterId: current.posterId };
  });

  if (result.changed && result.previousPosterId) {
    await logPosterAudit({
      action: "EVENT_POSTER_UNPUBLISHED",
      userId: options.userId,
      catalogId: options.catalogId,
      eventId: options.eventId,
      posterId: result.previousPosterId,
    });
  }
  return result;
}

export async function deleteEventPosterCandidate(options: {
  catalogId: string;
  eventId: number;
  posterId: string;
  userId: string;
}): Promise<void> {
  let stagedAssets: StagedPosterCandidateAssetsRemoval | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      await lockEvent(tx, options.catalogId, options.eventId);
      const candidate = await tx.catalogEventPoster.findFirst({
        where: {
          id: options.posterId,
          eventId: options.eventId,
          workflowGroupId: options.catalogId,
        },
        select: { id: true, publication: { select: { posterId: true } } },
      });
      if (!candidate) {
        throw new EventPosterServiceError("Poster candidate not found", 404);
      }
      if (candidate.publication) {
        throw new EventPosterServiceError("Published poster must be unpublished before deletion", 409);
      }
      stagedAssets = await stagePosterCandidateAssetsRemoval(options.catalogId, options.eventId, options.posterId);
      await tx.catalogEventPoster.delete({ where: { id: options.posterId } });
    });
  } catch (error) {
    if (stagedAssets) {
      await restoreStagedEventPosterAssets(stagedAssets);
    }
    throw error;
  }

  await logPosterAudit({
    action: "EVENT_POSTER_DELETED",
    userId: options.userId,
    catalogId: options.catalogId,
    eventId: options.eventId,
    posterId: options.posterId,
  });
  if (stagedAssets) {
    await finalizeStagedEventPosterAssetsRemoval(stagedAssets).catch((error) => {
      console.error("Failed to finalize poster candidate cleanup:", error);
    });
  }
}

async function findPosterAssetRecord(options: {
  catalogId: string;
  eventId: number;
  posterId?: string;
  publishedOnly: boolean;
}) {
  if (options.publishedOnly) {
    const publication = await prisma.catalogEventPosterPublication.findUnique({
      where: {
        workflowGroupId_eventId: {
          workflowGroupId: options.catalogId,
          eventId: options.eventId,
        },
      },
      select: {
        poster: {
          select: {
            id: true,
            squareExtension: true,
            landscapeExtension: true,
          },
        },
      },
    });
    return publication?.poster ?? null;
  }

  if (!options.posterId) return null;
  return prisma.catalogEventPoster.findFirst({
    where: {
      id: options.posterId,
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

export async function loadEventPosterAsset(options: {
  catalogId: string;
  eventId: number;
  posterId?: string;
  variant: PosterVariant;
  publishedOnly: boolean;
}): Promise<{
  bytes: Buffer;
  contentType: string;
  posterId: string;
  sha256: string;
} | null> {
  const poster = await findPosterAssetRecord(options);
  if (!poster) return null;
  const extension = (
    options.variant === "square" ? poster.squareExtension : poster.landscapeExtension
  ) as PosterExtension;
  const filePath = resolveEventPosterAssetPath(
    options.catalogId,
    options.eventId,
    poster.id,
    options.variant,
    extension
  );
  const asset = await readPosterAsset(filePath);
  if (!asset) return null;
  return {
    bytes: asset.bytes,
    contentType: getPosterContentType(extension),
    posterId: poster.id,
    sha256: createAssetEtag(asset.bytes),
  };
}

function createAssetEtag(bytes: Buffer): string {
  // A strong digest keeps conditional requests stable for immutable candidate
  // bytes without exposing filesystem metadata.
  return createHash("sha256").update(bytes).digest("hex");
}

export async function getPublishedEventPoster(
  catalogId: string,
  eventId: number
): Promise<PublishedEventPosterView | null> {
  const publication = await prisma.catalogEventPosterPublication.findUnique({
    where: {
      workflowGroupId_eventId: { workflowGroupId: catalogId, eventId },
    },
    select: {
      publishedAt: true,
      poster: {
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
    id: publication.poster.id,
    publishedAt: publication.publishedAt.toISOString(),
    assets: {
      square: {
        bytes: publication.poster.squareBytes,
        sha256: publication.poster.squareSha256,
      },
      landscape: {
        bytes: publication.poster.landscapeBytes,
        sha256: publication.poster.landscapeSha256,
      },
    },
  };
}

export type PosterWorkflowStatus = "none" | "draft-only" | "published" | "published-with-newer-drafts";

export async function getEventPosterWorkflowStatuses(
  catalogId: string,
  eventIds: number[]
): Promise<Map<number, PosterWorkflowStatus>> {
  const result = new Map<number, PosterWorkflowStatus>();
  for (const eventId of eventIds) result.set(eventId, "none");
  if (eventIds.length === 0) return result;

  const candidates = await prisma.catalogEventPoster.findMany({
    where: { workflowGroupId: catalogId, eventId: { in: eventIds } },
    select: { eventId: true, createdAt: true },
  });
  const publications = await prisma.catalogEventPosterPublication.findMany({
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
