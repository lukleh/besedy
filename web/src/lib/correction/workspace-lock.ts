import type { Prisma } from "@/generated/prisma/client";
import { CorrectionError } from "@/lib/correction/errors";
import { completeStartingManifest } from "@/lib/correction/storage";
import { createServerLogger } from "@/lib/log/server";

const logger = createServerLogger("correction.workspace-lock");

/**
 * How long a writer waits for the workspace row before it gives up with
 * `WORKSPACE_LOCKED`. Other decisions hold it for milliseconds and a
 * publication's prepare step for a few seconds; waiting longer only runs the
 * caller's transaction into its own timeout, which surfaces as a server
 * error instead of a conflict the person can act on.
 */
export const WORKSPACE_LOCK_WAIT_MS = 5_000;

/**
 * Bounds for the writers that hold the workspace row briefly: decisions,
 * edits, flags and comments. `lockWorkspace` gives up on the row after
 * `WORKSPACE_LOCK_WAIT_MS`, so the transaction's own limit only has to cover
 * that wait plus the writes; Prisma's default of five seconds did not, and a
 * writer caught behind a publication's prepare step timed out as a server
 * error instead of a conflict.
 */
export const SHORT_WRITE_TRANSACTION = { maxWait: 10_000, timeout: 15_000 } as const;

/** PostgreSQL `lock_not_available`, raised when `lock_timeout` expires. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Whether a database error is PostgreSQL giving up on a lock.
 *
 * Prisma 7 with a driver adapter reports a failed raw query as `P2010` with
 * the SQLSTATE in `meta.driverAdapterError.cause.originalCode` or `cause.code`.
 * The raw-query message is the final fallback.
 */
export function isLockTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, meta, message } = error as {
    code?: unknown;
    meta?: {
      driverAdapterError?: { cause?: { code?: unknown; originalCode?: unknown } };
    };
    message?: unknown;
  };
  const cause = meta?.driverAdapterError?.cause;
  if (cause?.originalCode === LOCK_NOT_AVAILABLE || cause?.code === LOCK_NOT_AVAILABLE) return true;
  return code === "P2010" && typeof message === "string" && message.includes(LOCK_NOT_AVAILABLE);
}

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
 * Holding the lock on a live workspace also finishes a start that
 * committed its rows but never rewrote its manifest from `starting` to
 * `active` (ADR 0012). Under the lock no archive can interleave, so the
 * rewrite cannot undo an `archived` manifest.
 */
export async function lockWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: string
): Promise<void> {
  // SET LOCAL lasts for this transaction only. The value is a constant, so
  // the statement needs no parameters, which SET does not accept anyway.
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${WORKSPACE_LOCK_WAIT_MS}ms'`);

  let rows: { id: string; workflow_group_id: string; status: string }[];
  try {
    rows = await tx.$queryRaw<
      { id: string; workflow_group_id: string; status: string }[]
    >`
      SELECT "id", "workflow_group_id", "status"::text AS "status"
      FROM "transcript_workspace"
      WHERE "id" = ${workspaceId}::uuid
      FOR UPDATE
    `;
  } catch (error) {
    if (isLockTimeout(error)) {
      throw new CorrectionError(
        "WORKSPACE_LOCKED",
        "Another change to this transcript is being saved or it is being published; try again in a moment"
      );
    }
    throw error;
  }

  const row = rows[0];
  if (!row) {
    throw new CorrectionError("NO_WORKSPACE", "Correction workspace not found");
  }
  if (row.status === "ACTIVE") {
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
