import type { Prisma } from "@/generated/prisma/client";
import { CorrectionError } from "@/lib/correction/errors";

/**
 * Serialize everything that touches one workspace.
 *
 * Checking for an in-flight publication and then acting on the answer is not
 * enough: a decision transaction can pass that check, a publisher can then
 * create the pending publication and snapshot the still-approved state, and
 * the decision commits afterwards — publishing a span somebody had just
 * disputed. The check has to hold a lock the publisher also wants.
 *
 * Every writer takes this first, so the order is always workspace then span
 * and two writers cannot deadlock against each other.
 */
export async function lockWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: string
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "transcript_workspace"
    WHERE "id" = ${workspaceId}::uuid
    FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new CorrectionError("NO_WORKSPACE", "Correction workspace not found");
  }
}
