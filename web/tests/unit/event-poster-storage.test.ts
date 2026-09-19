import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { config } = vi.hoisted(() => ({ config: { postersDir: "" } }));

vi.mock("@/lib/config", () => ({
  getPostersDir: () => config.postersDir,
  getSourcesDir: () => {
    throw new Error("not configured");
  },
  getTextDataDir: () => {
    throw new Error("not configured");
  },
}));

import {
  finalizeStagedEventPosterAssetsRemoval,
  PosterAssetError,
  processPosterAsset,
  readPosterAsset,
  resolveEventPostersPath,
  restoreStagedEventPosterAssets,
  stageEventPosterAssetsRemoval,
} from "@/lib/event-poster-storage";

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 24, g: 48, b: 72 },
    },
  })
    .png()
    .toBuffer();
}

describe("event poster storage", () => {
  let testRoot: string;
  let outsideRoot: string;
  let originalBaseDir: string | undefined;
  let originalAllowedPaths: string | undefined;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-poster-storage-"));
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-poster-outside-"));
    config.postersDir = testRoot;
    originalBaseDir = process.env.BESEDY_BASE_DIR;
    originalAllowedPaths = process.env.BESEDY_ALLOWED_PATHS;
    delete process.env.BESEDY_BASE_DIR;
    delete process.env.BESEDY_ALLOWED_PATHS;
  });

  afterEach(async () => {
    if (originalBaseDir === undefined) delete process.env.BESEDY_BASE_DIR;
    else process.env.BESEDY_BASE_DIR = originalBaseDir;
    if (originalAllowedPaths === undefined) delete process.env.BESEDY_ALLOWED_PATHS;
    else process.env.BESEDY_ALLOWED_PATHS = originalAllowedPaths;
    await Promise.all([
      fs.rm(testRoot, { recursive: true, force: true }),
      fs.rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  it("accepts, normalizes, and fingerprints a square image", async () => {
    const result = await processPosterAsset({ bytes: await png(1800, 1800), originalName: "../cover.png" }, "square");

    expect(result.originalName).toBe("cover.png");
    expect(result.extension).toBe(".png");
    expect(result.width).toBe(1600);
    expect(result.height).toBe(1600);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a 16:9 landscape image", async () => {
    const result = await processPosterAsset({ bytes: await png(1600, 900), originalName: "wide.png" }, "landscape");

    expect(result.width / result.height).toBeCloseTo(16 / 9, 3);
  });

  it("rejects an image submitted for the wrong shape", async () => {
    await expect(
      processPosterAsset({ bytes: await png(1200, 800), originalName: "wrong.png" }, "square")
    ).rejects.toMatchObject({
      code: "INVALID_ASPECT_RATIO",
    } satisfies Partial<PosterAssetError>);
  });

  it("rejects invalid bytes", async () => {
    await expect(
      processPosterAsset({ bytes: Buffer.from("not an image"), originalName: "fake.jpg" }, "square")
    ).rejects.toMatchObject({
      code: "INVALID_FILE",
    } satisfies Partial<PosterAssetError>);
  });

  it("returns no staging record when the event poster directory is absent", async () => {
    await expect(stageEventPosterAssetsRemoval("20260919_120000", 7)).resolves.toBeNull();
  });

  it("returns no asset when a poster file is missing", async () => {
    const missingPath = path.join(resolveEventPostersPath("20260919_120000"), "7", "poster", "square.png");

    await expect(readPosterAsset(missingPath)).resolves.toBeNull();
  });

  it("rejects staging a poster directory that resolves outside the poster root", async () => {
    const eventPath = path.join(resolveEventPostersPath("20260919_120000"), "7");
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.symlink(outsideRoot, eventPath);

    await expect(stageEventPosterAssetsRemoval("20260919_120000", 7)).rejects.toThrow("Invalid event poster directory");
  });

  it("merges staged assets back when the live directory was recreated", async () => {
    const eventPath = path.join(resolveEventPostersPath("20260919_120000"), "7");
    await fs.mkdir(path.join(eventPath, "old-poster"), { recursive: true });
    await fs.writeFile(path.join(eventPath, "old-poster", "square.png"), "old");
    const staged = await stageEventPosterAssetsRemoval("20260919_120000", 7);
    expect(staged).not.toBeNull();

    await fs.mkdir(path.join(eventPath, "new-poster"), { recursive: true });
    await fs.writeFile(path.join(eventPath, "new-poster", "square.png"), "new");
    await restoreStagedEventPosterAssets(staged!);

    await expect(fs.readFile(path.join(eventPath, "old-poster", "square.png"), "utf8")).resolves.toBe("old");
    await expect(fs.readFile(path.join(eventPath, "new-poster", "square.png"), "utf8")).resolves.toBe("new");
    await expect(fs.lstat(staged!.stagedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes a staged directory during finalization", async () => {
    const eventPath = path.join(resolveEventPostersPath("20260919_120000"), "7");
    await fs.mkdir(eventPath, { recursive: true });
    const staged = await stageEventPosterAssetsRemoval("20260919_120000", 7);

    await finalizeStagedEventPosterAssetsRemoval(staged!);

    await expect(fs.lstat(staged!.stagedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
