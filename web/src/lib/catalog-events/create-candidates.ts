import type { Prisma } from "@/generated/prisma/client";
import type { EventCreationCandidate } from "@/lib/catalog-events/create-conflict";
import { resolveCatalogRecordingTitle } from "@/lib/catalog-recordings/read-service";
import { normalizeOptionalString } from "@/lib/catalog-events/utils";

export interface EventCreationIdentity {
  workflowGroupId: string;
  locationId: number;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
}

export interface EventCreationContext {
  candidates: EventCreationCandidate[];
  nextSessionIndex: number;
}

export async function loadEventCreationContext(
  tx: Prisma.TransactionClient,
  identity: EventCreationIdentity
): Promise<EventCreationContext> {
  const events = await tx.catalogEvent.findMany({
    where: identity,
    select: {
      id: true,
      title: true,
      sessionIndex: true,
      recordings: {
        orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }],
        take: 1,
        select: { audioHash: true },
      },
      _count: { select: { recordings: true } },
    },
    orderBy: { sessionIndex: "asc" },
  });

  const representativeHashes = events
    .map((event) => event.recordings[0]?.audioHash)
    .filter((hash): hash is string => typeof hash === "string");
  const [catalogRows, metadataRows] =
    representativeHashes.length === 0
      ? [[], []]
      : await Promise.all([
          tx.catalogEntry.findMany({
            where: {
              workflowGroupId: identity.workflowGroupId,
              audioHash: { in: representativeHashes },
            },
            select: { audioHash: true, sourceTitle: true },
          }),
          tx.audioMetadata.findMany({
            where: {
              workflowGroupId: identity.workflowGroupId,
              audioHash: { in: representativeHashes },
            },
            select: { audioHash: true, title: true },
          }),
        ]);

  const sourceTitleByHash = new Map(
    catalogRows.map((row) => [row.audioHash, row.sourceTitle])
  );
  const curatedTitleByHash = new Map(
    metadataRows.map((row) => [row.audioHash, row.title])
  );

  return {
    candidates: events.map((event) => {
      const representativeHash = event.recordings[0]?.audioHash;
      return {
        id: event.id,
        title: event.title,
        sessionIndex: event.sessionIndex,
        recordingCount: event._count.recordings,
        // resolveCatalogRecordingTitle falls back with ??, so a recording
        // whose curated title is stored as an empty string resolves to "".
        // Left as-is that reaches the dialog as a blank heading, so collapse
        // it to null and let the caller fall back to the event title.
        primaryTitle:
          representativeHash === undefined
            ? null
            : normalizeOptionalString(
                resolveCatalogRecordingTitle(representativeHash, {
                  curatedTitle: curatedTitleByHash.get(representativeHash),
                  sourceTitle: sourceTitleByHash.get(representativeHash),
                })
              ),
      };
    }),
    nextSessionIndex: (events.at(-1)?.sessionIndex ?? 0) + 1,
  };
}
