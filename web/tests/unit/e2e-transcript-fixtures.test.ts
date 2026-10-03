import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_AUDIO_FILES,
  TEST_TRANSCRIPTS_COMPLETE_MARKER,
  TEST_TRANSCRIPTS_SUBDIR,
} from "../../prisma/test-data";
import { generateAllTranscripts } from "../e2e/scripts/generate-transcripts";

let fixturesDir: string;

beforeEach(async () => {
  fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-e2e-fixtures-"));
});

afterEach(async () => {
  await fs.rm(fixturesDir, { recursive: true, force: true });
});

async function expectGeneratedTree(): Promise<void> {
  const catalogDir = path.join(fixturesDir, TEST_TRANSCRIPTS_SUBDIR);
  const first = TEST_AUDIO_FILES[0];
  await expect(
    fs.stat(path.join(catalogDir, "faster-whisper", "large-v3@silero_vad_v6@lang-cs", first.hash, "transcript.json"))
  ).resolves.toBeDefined();
  await expect(fs.stat(path.join(fixturesDir, TEST_TRANSCRIPTS_COMPLETE_MARKER))).resolves.toBeDefined();
  // `transcripts` is a real directory, whatever it was before.
  expect((await fs.lstat(path.join(fixturesDir, "transcripts"))).isDirectory()).toBe(true);
}

describe("generateAllTranscripts", () => {
  it("writes the transcript fixtures into an empty fixtures directory", async () => {
    await generateAllTranscripts(fixturesDir);

    await expectGeneratedTree();
  });

  it("replaces the legacy transcripts -> transcripts_test symlink", async () => {
    const legacy = path.join(fixturesDir, "transcripts_test");
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, "stale.json"), "{}");
    await fs.symlink("transcripts_test", path.join(fixturesDir, "transcripts"));

    await generateAllTranscripts(fixturesDir);

    await expectGeneratedTree();
    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces a dangling legacy symlink", async () => {
    await fs.symlink("transcripts_test", path.join(fixturesDir, "transcripts"));

    await generateAllTranscripts(fixturesDir);

    await expectGeneratedTree();
  });

  it("clears fixtures of hashes that are no longer generated", async () => {
    const stale = path.join(fixturesDir, TEST_TRANSCRIPTS_SUBDIR, "faster-whisper", "old", "f".repeat(64));
    await fs.mkdir(stale, { recursive: true });

    await generateAllTranscripts(fixturesDir);

    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expectGeneratedTree();
  });
});
