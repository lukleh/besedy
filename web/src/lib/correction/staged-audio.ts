import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CorrectionError } from "@/lib/correction/errors";
import { createServerLogger } from "@/lib/log/server";
import { rewritePath, validatePathAsync } from "@/lib/security/path-validation";

const logger = createServerLogger("correction.staged-audio");

/** The staged 16 kHz WAV a workspace's span times refer to (ADR 0012). */
export interface StagedAudioIdentity {
  /** As the machine source recorded it, which is the host path */
  path: string;
  size: number;
  sha256: string;
}

/** The largest difference tolerated between the WAV and the source's duration. */
export const STAGED_AUDIO_DURATION_TOLERANCE_SECONDS = 0.05;

function audioFilepathOf(meta: Record<string, unknown> | undefined): string | null {
  const value = meta?.audio_filepath;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function durationOf(meta: Record<string, unknown> | undefined): number | null {
  const value = meta?.duration;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The 44-byte canonical header plus room for a few extra chunks. */
const WAV_HEADER_READ_BYTES = 4096;

/**
 * Duration of a PCM WAV from its chunk headers alone.
 *
 * Reads only the start of the file: the RIFF header, then the chunk headers
 * until both `fmt ` and `data` have been seen. The `data` chunk's payload is
 * never read; its declared size divided by the byte rate is the duration.
 * Returns null when the file is not a PCM WAV this parser understands.
 */
export async function readWavDurationSeconds(filePath: string): Promise<number | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(WAV_HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseWavDurationSeconds(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** The pure part of `readWavDurationSeconds`, over the file's leading bytes. */
export function parseWavDurationSeconds(head: Buffer): number | null {
  if (head.length < 12 || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset + 8 <= head.length && (byteRate === null || dataBytes === null)) {
    const id = head.toString("ascii", offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > head.length) return null;
      const format = head.readUInt16LE(body);
      const channels = head.readUInt16LE(body + 2);
      const sampleRate = head.readUInt32LE(body + 4);
      const bitsPerSample = head.readUInt16LE(body + 14);
      if (format !== 1 || channels === 0 || sampleRate === 0 || bitsPerSample % 8 !== 0 || bitsPerSample === 0) {
        return null;
      }
      byteRate = sampleRate * channels * (bitsPerSample / 8);
    } else if (id === "data") {
      dataBytes = size;
      // The data chunk is last in a staged WAV; stop before walking past it.
      break;
    }
    // Chunks are word-aligned: an odd-sized chunk carries one padding byte.
    offset = body + size + (size % 2);
  }
  if (byteRate === null || dataBytes === null) return null;
  return dataBytes / byteRate;
}

/**
 * Fingerprint the staged audio the frozen source was transcribed from.
 *
 * Training rebuilds each chunk's audio from this file, so a workspace records
 * which bytes its times refer to. The file is named by the recording's audio
 * hash; any other name means the source points at a different recording, and
 * a duration that disagrees with the source's means the file was re-staged
 * from different audio since the transcript was made.
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
    // The reason names host paths and allowed directories; it stays in the log.
    logger.warn("Staged audio path rejected", { audioHash, reason: check.reason ?? "unknown reason" });
    throw new CorrectionError("STAGED_AUDIO_MISSING", "The staged audio for this recording is not available");
  }

  const stat = await fs.stat(check.resolvedPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new CorrectionError("STAGED_AUDIO_MISSING", "The staged audio for this recording is empty");
  }

  const expectedDuration = durationOf(meta);
  if (expectedDuration !== null) {
    const wavDuration = await readWavDurationSeconds(check.resolvedPath);
    if (wavDuration === null) {
      throw new CorrectionError(
        "STAGED_AUDIO_MISMATCH",
        "The staged audio for this recording is not a PCM WAV file"
      );
    }
    if (Math.abs(wavDuration - expectedDuration) > STAGED_AUDIO_DURATION_TOLERANCE_SECONDS) {
      throw new CorrectionError(
        "STAGED_AUDIO_MISMATCH",
        `The staged audio's duration differs from the machine transcript's: ${wavDuration.toFixed(3)} s on disk, ${expectedDuration.toFixed(3)} s in the transcript`
      );
    }
  }

  // Size and hash are taken from the same bytes, so they cannot disagree.
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(check.resolvedPath)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
  }
  return { path: recorded, size, sha256: hash.digest("hex") };
}
