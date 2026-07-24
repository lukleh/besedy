import type { PrismaClient } from "@/generated/prisma/client";
import {
  canViewRecordingForAccessLevel,
  type RecordingVisibilityState,
} from "@/lib/policy/recording";
import { canViewEvent, type ListenerVisibleEventState } from "@/lib/policy/event";

type VisibilityClient = Pick<PrismaClient, "$queryRaw" | "catalogEntry">;
type EventVisibilityRow = {
  eventId: number;
  released: boolean;
  primaryRecordingActionable: boolean | null;
  primaryRecordingPublished: boolean | null;
};

function isListenerVisibleRecordingState(
  state: RecordingVisibilityState | undefined
): boolean {
  return canViewRecordingForAccessLevel("LISTENER", state);
}

function isListenerVisibleEventRow(row: EventVisibilityRow): boolean {
  const state: ListenerVisibleEventState = {
    released: row.released,
    primaryRecordingActionable: row.primaryRecordingActionable === true,
    primaryRecordingPublished: row.primaryRecordingPublished === true,
  };

  return canViewEvent(
    {
      featureEnabled: true,
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "LISTENER",
      isCatalogAdmin: false,
    },
    state
  );
}

// Event visibility is driven by a released event whose primary recording is
// actionable and published.
export async function getPublishedVisibleEventIds(
  prisma: VisibilityClient,
  workflowGroupId: string
): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<EventVisibilityRow>>`
    SELECT e.id AS "eventId",
           e.released AS "released",
           ce.is_actionable AS "primaryRecordingActionable",
           ce.is_published AS "primaryRecordingPublished"
    FROM catalog_event e
    LEFT JOIN catalog_event_recording cer
      ON cer.event_id = e.id
     AND cer.workflow_group_id = e.workflow_group_id
     AND cer.is_primary = true
    LEFT JOIN catalog_entry ce
      ON ce.workflow_group_id = cer.workflow_group_id
     AND ce.audio_hash = cer.audio_hash
    WHERE e.workflow_group_id = ${workflowGroupId}
      AND e.released = true
    ORDER BY e.id
  `;

  return rows.filter(isListenerVisibleEventRow).map((row) => row.eventId);
}

export async function isPublishedVisibleEvent(
  prisma: VisibilityClient,
  workflowGroupId: string,
  eventId: number
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<EventVisibilityRow>>`
    SELECT e.id AS "eventId",
           e.released AS "released",
           ce.is_actionable AS "primaryRecordingActionable",
           ce.is_published AS "primaryRecordingPublished"
    FROM catalog_event e
    LEFT JOIN catalog_event_recording cer
      ON cer.event_id = e.id
     AND cer.workflow_group_id = e.workflow_group_id
     AND cer.is_primary = true
    LEFT JOIN catalog_entry ce
      ON ce.workflow_group_id = cer.workflow_group_id
     AND ce.audio_hash = cer.audio_hash
    WHERE e.workflow_group_id = ${workflowGroupId}
      AND e.id = ${eventId}
  `;

  return rows.some(isListenerVisibleEventRow);
}

export async function getPublishedAccessibleRecordingHashes(
  prisma: VisibilityClient,
  workflowGroupId: string,
  audioHashes: string[]
): Promise<Set<string>> {
  if (audioHashes.length === 0) {
    return new Set();
  }

  const rows = await prisma.catalogEntry.findMany({
    where: {
      workflowGroupId,
      audioHash: { in: audioHashes },
    },
    select: { audioHash: true, isActionable: true, isPublished: true },
  });

  return new Set(
    rows
      .filter((row) =>
        isListenerVisibleRecordingState({
          isActionable: row.isActionable,
          isPublished: row.isPublished,
        })
      )
      .map((row) => row.audioHash)
  );
}
