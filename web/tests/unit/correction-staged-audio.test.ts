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
});
