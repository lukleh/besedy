import type { Prisma } from "@/generated/prisma/client";
import { CorrectionError } from "@/lib/correction/errors";
import { completeStartingManifest } from "@/lib/correction/storage";
import { createServerLogger } from "@/lib/log/server";

const logger = createServerLogger("correction.workspace-lock");

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
 *
 * Holding the lock on a live contract workspace also finishes a start that
 * committed its rows but never rewrote its manifest from `starting` to
 * `active` (ADR 0012). Under the lock no archive can interleave, so the
 * rewrite cannot undo an `archived` manifest.
 */
export async function lockWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: string
): Promise<void> {
  const rows = await tx.$queryRaw<
    { id: string; workflow_group_id: string; status: string; segmentation_version: string | null }[]
  >`
    SELECT "id", "workflow_group_id", "status"::text AS "status", "segmentation_version"
    FROM "transcript_workspace"
    WHERE "id" = ${workspaceId}::uuid
    FOR UPDATE
  `;

  const row = rows[0];
  if (!row) {
    throw new CorrectionError("NO_WORKSPACE", "Correction workspace not found");
  }
  if (row.status === "ACTIVE" && row.segmentation_version !== null) {
    // Best effort: the manifest stays protective either way, and a broken one
    // is the nightly integrity check's to report, not a reason to refuse work.
    await completeStartingManifest(row.workflow_group_id, row.id).catch((error: unknown) => {
      logger.warn("Could not finish a starting workspace manifest", {
        workspaceId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
