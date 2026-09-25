import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A real temporary tree stands in for the corrections root, and the config is
// pointed at it so path validation treats it as an allowed directory.
let root: string;

vi.mock("@/lib/config", () => ({
  getCorrectionsDir: () => root,
  getTextDataDir: () => path.join(root, "..", "text"),
  getArtworkDir: () => path.join(root, "..", "artwork"),
  getSourcesDir: () => path.join(root, "..", "sources"),
  getUploadsDir: () => path.join(root, "..", "uploads"),
}));

describe("corrections storage", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-corrections-"));
    root = await fs.realpath(root);
    vi.resetModules();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns null for a file that does not exist, at any depth", async () => {
    const { readJsonFile, readTextFile } = await import("@/lib/correction/storage");
    await expect(readTextFile(path.join(root, "missing.json"))).resolves.toBeNull();
    await expect(
      readJsonFile(path.join(root, "corrections_x", "index-sources", "missing.json"))
    ).resolves.toBeNull();
  });

  it("throws for a file outside the allowed directories rather than reporting it absent", async () => {
    const { readTextFile } = await import("@/lib/correction/storage");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-outside-"));
    await fs.writeFile(path.join(outside, "pointer.json"), "{}");
    await expect(readTextFile(path.join(outside, "pointer.json"))).rejects.toThrow(
      /Invalid corrections path/
    );
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("throws on malformed JSON rather than reporting the file absent", async () => {
    const { readJsonFile, writeFileAtomic } = await import("@/lib/correction/storage");
    const target = path.join(root, "corrections_x", "index-sources", "bad.json");
    await writeFileAtomic(target, "{ not json");
    await expect(readJsonFile(target)).rejects.toThrow();
  });

  it("refuses to read through a symlink that leaves the allowed directories", async () => {
    const { readTextFile } = await import("@/lib/correction/storage");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-outside-"));
    await fs.writeFile(path.join(outside, "secret.json"), "{}");
    await fs.mkdir(path.join(root, "corrections_x"), { recursive: true });
    await fs.symlink(path.join(outside, "secret.json"), path.join(root, "corrections_x", "link.json"));
    await expect(readTextFile(path.join(root, "corrections_x", "link.json"))).rejects.toThrow(
      /Invalid corrections path/
    );
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("neither creates nor chmods anything through a directory symlink that leaves the tree", async () => {
    const { writeFileAtomic } = await import("@/lib/correction/storage");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-outside-"));
    const before = (await fs.stat(outside)).mode & 0o7777;
    await fs.mkdir(path.join(root, "corrections_x"), { recursive: true });
    await fs.symlink(outside, path.join(root, "corrections_x", "escape"));
    await expect(
      writeFileAtomic(path.join(root, "corrections_x", "escape", "deeper", "file.json"), "{}")
    ).rejects.toThrow(/outside the allowed paths/);
    await expect(fs.stat(path.join(outside, "deeper"))).rejects.toThrow();
    expect((await fs.stat(outside)).mode & 0o7777).toBe(before);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("creates every level below the root with the shared setgid mode and files group-writable", async () => {
    const { writeFileAtomic } = await import("@/lib/correction/storage");
    const target = path.join(root, "corrections_x", "ws", "publications", "p", "transcript.json");
    await writeFileAtomic(target, "{}\n");
    for (const dir of [
      path.join(root, "corrections_x"),
      path.join(root, "corrections_x", "ws"),
      path.join(root, "corrections_x", "ws", "publications", "p"),
    ]) {
      const mode = (await fs.stat(dir)).mode & 0o7777;
      expect(mode & 0o770).toBe(0o770);
      expect(mode & 0o2000).toBe(0o2000);
    }
    expect((await fs.stat(target)).mode & 0o777).toBe(0o660);
  });
});
