import { getRecordingCapability, type RecordingCapability } from "@/lib/access/capabilities";
import { logAccessDenied } from "@/lib/audit/logger";
import { AuthError, requireAuth } from "@/lib/auth/permissions";

export type CorrectionAccessMode = "correct" | "publish";

export interface CorrectionAccess {
  userId: string;
  capability: RecordingCapability;
}

/**
 * The correction surface and the publication control are different authorities
 * over the same recording, so they are asked for by name.
 *
 * Correcting does not imply publishing: the `corrector` role deliberately
 * stops at the working surface.
 */
export async function requireCorrectionAccess(
  catalogId: string,
  audioHash: string,
  mode: CorrectionAccessMode
): Promise<CorrectionAccess> {
  const userId = await requireAuth();
  const capability = await getRecordingCapability(catalogId, audioHash, userId);

  if (!capability.canAccessRecording) {
    await logAccessDenied(userId, "transcript_correction", audioHash, {
      catalogId,
      mode,
      reason: "Recording is outside the actor's visibility scope",
    });
    throw new AuthError("Recording not found", 404);
  }

  const allowed =
    mode === "correct"
      ? capability.canCorrectTranscripts
      : capability.canPublishTranscript;

  if (!allowed) {
    await logAccessDenied(userId, "transcript_correction", audioHash, {
      catalogId,
      mode,
      reason: "Missing correction authority",
    });
    throw new AuthError(
      mode === "correct"
        ? "Access denied to the correction surface"
        : "Publishing transcripts is not permitted for this account",
      403
    );
  }

  return { userId, capability };
}
