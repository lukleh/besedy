import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEST_AUDIO_FILES,
  TEST_TRANSCRIPTS_COMPLETE_MARKER,
  TEST_TRANSCRIPTS_SUBDIR,
} from "../../prisma/test-data";
import { generateAllTranscripts } from "../e2e/scripts/generate-transcripts";

let fixturesDir: string;

beforeEach(async () => {
  fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-e2e-fixtures-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(fixturesDir, { recursive: true, force: true });
});

async function expectGeneratedTree(): Promise<void> {
  const catalogDir = path.join(fixturesDir, TEST_TRANSCRIPTS_SUBDIR);
  for (const file of TEST_AUDIO_FILES) {
    // Every backend writes a transcript for every test recording...
    const backends = await fs.readdir(catalogDir);
    expect(backends).toContain("faster-whisper");
    for (const backend of backends.filter((name) => name !== "speaker_diarization")) {
      const [component] = await fs.readdir(path.join(catalogDir, backend));
      const raw = await fs.readFile(path.join(catalogDir, backend, component, file.hash, "transcript.json"), "utf-8");
      expect(Object.keys(JSON.parse(raw)).length).toBeGreaterThan(0);
    }
  }
  for (const file of TEST_AUDIO_FILES) {
    const speakers = await fs.readFile(
      path.join(catalogDir, "speaker_diarization", "pyannote_3.1", file.hash, "speakers.json"),
      "utf-8"
    );
    expect(JSON.parse(speakers).hash).toBe(file.hash);
  }
  // ...and the run is marked complete.
  expect((await fs.stat(path.join(fixturesDir, TEST_TRANSCRIPTS_COMPLETE_MARKER))).isFile()).toBe(true);
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
