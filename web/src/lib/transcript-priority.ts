import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";

export interface TranscriptBackendPriorityUpdate {
  backend: string;
  priority: number | null;
}

export async function listTranscriptBackendPriorities(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ backend: string; priority: number }>>(
    Prisma.sql`SELECT backend, priority FROM transcript_backend_priority`
  );

  const priorities: Record<string, number> = {};
  for (const row of rows) {
    priorities[row.backend] = row.priority;
  }
  return priorities;
}

export async function updateTranscriptBackendPriorities(
  updates: TranscriptBackendPriorityUpdate[]
): Promise<void> {
  if (updates.length === 0) return;

  const toDelete = updates
    .filter((item) => item.priority === null || item.priority === undefined)
    .map((item) => item.backend);
  const toUpsert = updates.filter(
    (item) => item.priority !== null && item.priority !== undefined
  ) as Array<{ backend: string; priority: number }>;

  await prisma.$transaction(async (tx) => {
    if (toDelete.length > 0) {
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM transcript_backend_priority WHERE backend IN (${Prisma.join(toDelete)})`
      );
    }

    for (const item of toUpsert) {
      await tx.$executeRaw(
        Prisma.sql`
          INSERT INTO transcript_backend_priority (backend, priority, created_at, updated_at)
          VALUES (${item.backend}, ${Math.trunc(item.priority)}, NOW(), NOW())
          ON CONFLICT (backend)
          DO UPDATE SET priority = EXCLUDED.priority, updated_at = NOW()
        `
      );
    }
  });
}
