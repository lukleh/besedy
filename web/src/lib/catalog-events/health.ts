import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";

function toCountNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

export interface EventCatalogHealth {
  workflowGroupId: string;
  totalEvents: number;
  releasedEvents: number;
  unreleasedEvents: number;
  zeroRecordingEvents: number;
  missingPrimaryEvents: number;
  unassignedRecordings: number;
}

export async function getEventCatalogHealth(
  workflowGroupId: string
): Promise<EventCatalogHealth> {
  const [totalEvents, releasedEvents, unreleasedEvents, zeroRows, missingPrimaryRows, unassignedRows] =
    await Promise.all([
      prisma.catalogEvent.count({ where: { workflowGroupId } }),
      prisma.catalogEvent.count({ where: { workflowGroupId, released: true } }),
      prisma.catalogEvent.count({ where: { workflowGroupId, released: false } }),
      prisma.$queryRaw<Array<{ count: number | bigint | string }>>(Prisma.sql`
        SELECT COUNT(*) AS count
        FROM catalog_event e
        WHERE e.workflow_group_id = ${workflowGroupId}
          AND NOT EXISTS (
            SELECT 1
            FROM catalog_event_recording cer
            WHERE cer.event_id = e.id
          )
      `),
      prisma.$queryRaw<Array<{ count: number | bigint | string }>>(Prisma.sql`
        SELECT COUNT(*) AS count
        FROM catalog_event e
        WHERE e.workflow_group_id = ${workflowGroupId}
          AND NOT EXISTS (
            SELECT 1
            FROM catalog_event_recording cer
            WHERE cer.event_id = e.id
              AND cer.is_primary = true
          )
      `),
      prisma.$queryRaw<Array<{ count: number | bigint | string }>>(Prisma.sql`
        SELECT COUNT(*) AS count
        FROM catalog_entry ce
        WHERE ce.workflow_group_id = ${workflowGroupId}
          AND ce.is_actionable = true
          AND NOT EXISTS (
            SELECT 1
            FROM catalog_event_recording cer
            WHERE cer.workflow_group_id = ce.workflow_group_id
              AND cer.audio_hash = ce.audio_hash
          )
      `),
    ]);

  return {
    workflowGroupId,
    totalEvents,
    releasedEvents,
    unreleasedEvents,
    zeroRecordingEvents: toCountNumber(zeroRows[0]?.count ?? 0),
    missingPrimaryEvents: toCountNumber(missingPrimaryRows[0]?.count ?? 0),
    unassignedRecordings: toCountNumber(unassignedRows[0]?.count ?? 0),
  };
}
