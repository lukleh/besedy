import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CorrectionError } from "@/lib/correction/errors";
import { rewritePath, validatePathAsync } from "@/lib/security/path-validation";

/** The staged 16 kHz WAV a workspace's span times refer to (ADR 0012). */
export interface StagedAudioIdentity {
  /** As the machine source recorded it, which is the host path */
  path: string;
  size: number;
  sha256: string;
}

function audioFilepathOf(meta: Record<string, unknown> | undefined): string | null {
  const value = meta?.audio_filepath;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Fingerprint the staged audio the frozen source was transcribed from.
 *
 * Training rebuilds each chunk's audio from this file, so a workspace records
 * which bytes its times refer to. The file is named by the recording's audio
 * hash; any other name means the source points at a different recording.
 */
export async function identifyStagedAudio(
  meta: Record<string, unknown> | undefined,
  audioHash: string
): Promise<StagedAudioIdentity> {
  const recorded = audioFilepathOf(meta);
  if (!recorded) {
    throw new CorrectionError(
      "STAGED_AUDIO_MISSING",
      "The machine transcript does not record which staged audio it was made from"
    );
  }
  if (path.basename(recorded) !== `${audioHash}.wav`) {
    throw new CorrectionError(
      "STAGED_AUDIO_MISSING",
      `The machine transcript's staged audio ${path.basename(recorded)} is not this recording's`
    );
  }

  const check = await validatePathAsync(rewritePath(recorded));
  if (!check.valid) {
    throw new CorrectionError(
      "STAGED_AUDIO_MISSING",
      `The staged audio for this recording is not available: ${check.reason ?? "unknown reason"}`
    );
  }

  const stat = await fs.stat(check.resolvedPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new CorrectionError("STAGED_AUDIO_MISSING", "The staged audio for this recording is empty");
  }

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(check.resolvedPath)) {
    hash.update(chunk as Buffer);
  }
  return { path: recorded, size: stat.size, sha256: hash.digest("hex") };
}
