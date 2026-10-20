import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A real temporary tree stands in for the text data root, which path
// validation treats as an allowed directory.
let root: string;

vi.mock("@/lib/config", () => ({
  getCorrectionsDir: () => path.join(root, "corrections"),
  getTextDataDir: () => root,
  getArtworkDir: () => path.join(root, "artwork"),
  getSourcesDir: () => path.join(root, "sources"),
  getUploadsDir: () => path.join(root, "uploads"),
}));

const HASH = "a".repeat(64);

/** A 16 kHz mono PCM16 WAV with the given number of seconds of silence. */
function wavOf(seconds: number, extraChunk = false): Buffer {
  const dataBytes = Math.round(seconds * 32000);
  const extra = extraChunk ? Buffer.concat([Buffer.from("LIST"), u32(5), Buffer.from("abcde\0")]) : Buffer.alloc(0);
  const fmt = Buffer.concat([
    Buffer.from("fmt "),
    u32(16),
    u16(1), // PCM
    u16(1), // mono
    u32(16000),
    u32(32000), // byte rate
    u16(2), // block align
    u16(16),
  ]);
  const data = Buffer.concat([Buffer.from("data"), u32(dataBytes), Buffer.alloc(dataBytes)]);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, extra, data]);
  return Buffer.concat([Buffer.from("RIFF"), u32(body.length), body]);
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("staged audio identity", () => {
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "besedy-staged-")));
    vi.resetModules();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fingerprints the staged WAV the source names", async () => {
    const { identifyStagedAudio } = await import("@/lib/correction/staged-audio");
    const filePath = path.join(root, "audio_staged", `${HASH}.wav`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const bytes = Buffer.from("RIFF staged audio bytes");
    await fs.writeFile(filePath, bytes);

    await expect(identifyStagedAudio({ audio_filepath: filePath }, HASH)).resolves.toEqual({
      path: filePath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("refuses a source that names no staged audio", async () => {
    const { identifyStagedAudio } = await import("@/lib/correction/staged-audio");
    expect(await codeOf(identifyStagedAudio({}, HASH))).toBe("STAGED_AUDIO_MISSING");
    expect(await codeOf(identifyStagedAudio(undefined, HASH))).toBe("STAGED_AUDIO_MISSING");
  });

  it("refuses staged audio named for another recording", async () => {
    const { identifyStagedAudio } = await import("@/lib/correction/staged-audio");
    const filePath = path.join(root, `${"b".repeat(64)}.wav`);
    await fs.writeFile(filePath, "x");
    expect(await codeOf(identifyStagedAudio({ audio_filepath: filePath }, HASH))).toBe("STAGED_AUDIO_MISSING");
  });

  it("refuses staged audio that is missing, empty or outside the allowed directories", async () => {
    const { identifyStagedAudio } = await import("@/lib/correction/staged-audio");
    expect(await codeOf(identifyStagedAudio({ audio_filepath: path.join(root, `${HASH}.wav`) }, HASH))).toBe(
      "STAGED_AUDIO_MISSING"
    );

    const empty = path.join(root, "empty", `${HASH}.wav`);
    await fs.mkdir(path.dirname(empty), { recursive: true });
    await fs.writeFile(empty, "");
    expect(await codeOf(identifyStagedAudio({ audio_filepath: empty }, HASH))).toBe("STAGED_AUDIO_MISSING");

    const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "besedy-outside-")));
    const outside = path.join(outsideDir, `${HASH}.wav`);
    await fs.writeFile(outside, "x");
    try {
      expect(await codeOf(identifyStagedAudio({ audio_filepath: outside }, HASH))).toBe("STAGED_AUDIO_MISSING");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("accepts staged audio whose duration matches the source within 50 ms", async () => {
    const { identifyStagedAudio } = await import("@/lib/correction/staged-audio");
    const filePath = path.join(root, "audio_staged", `${HASH}.wav`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const bytes = wavOf(2.5, true);
    await fs.writeFile(filePath, bytes);

    await expect(identifyStagedAudio({ audio_filepath: filePath, duration: 2.54 }, HASH)).resolves.toEqual({
      path: filePath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("refuses staged audio whose duration differs from the source", async () => {
    const { identifyStagedAudio } = await import("@/lib/correction/staged-audio");
    const filePath = path.join(root, "audio_staged", `${HASH}.wav`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, wavOf(2.5));

    await expect(identifyStagedAudio({ audio_filepath: filePath, duration: 2.6 }, HASH)).rejects.toMatchObject({
      code: "STAGED_AUDIO_MISMATCH",
      statusCode: 422,
      message: expect.stringContaining("duration differs"),
    });
  });

  it("refuses a file that is not a PCM WAV when the source states a duration", async () => {
    const { identifyStagedAudio } = await import("@/lib/correction/staged-audio");
    const filePath = path.join(root, "audio_staged", `${HASH}.wav`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "RIFF staged audio bytes");

    expect(await codeOf(identifyStagedAudio({ audio_filepath: filePath, duration: 1 }, HASH))).toBe(
      "STAGED_AUDIO_MISMATCH"
    );
  });

  it("reads the duration from the chunk headers, skipping unknown chunks", async () => {
    const { parseWavDurationSeconds } = await import("@/lib/correction/staged-audio");
    expect(parseWavDurationSeconds(wavOf(1.25, true))).toBe(1.25);
    expect(parseWavDurationSeconds(wavOf(0))).toBe(0);
    expect(parseWavDurationSeconds(Buffer.from("not a wav file at all"))).toBeNull();
  });
});
