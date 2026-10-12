import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { config } = vi.hoisted(() => ({ config: { artworkDir: "" } }));

vi.mock("@/lib/config", () => ({
  getArtworkDir: () => config.artworkDir,
  getSourcesDir: () => {
    throw new Error("not configured");
  },
  getTextDataDir: () => {
    throw new Error("not configured");
  },
  getUploadsDir: () => {
    throw new Error("not configured");
  },
}));

import {
  backfillArtworkWebAssets,
  finalizeStagedEventArtworkAssetsRemoval,
  ArtworkAssetError,
  processArtworkAsset,
  readArtworkAsset,
  resolveEventArtworksPath,
  restoreStagedEventArtworkAssets,
  stageEventArtworkAssetsRemoval,
  writeArtworkCandidateAssets,
} from "@/lib/event-artwork-storage";

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

describe("event artwork storage", () => {
  let testRoot: string;
  let outsideRoot: string;
  let originalBaseDir: string | undefined;
  let originalAllowedPaths: string | undefined;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-artwork-storage-"));
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-artwork-outside-"));
    config.artworkDir = testRoot;
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
    const result = await processArtworkAsset({ bytes: await png(1800, 1800), originalName: "../cover.png" }, "square");

    expect(result.originalName).toBe("cover.png");
    expect(result.extension).toBe(".png");
    expect(result.width).toBe(1600);
    expect(result.height).toBe(1600);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("adds a WebP copy at the original's pixel size", async () => {
    const result = await processArtworkAsset({ bytes: await png(1254, 1254), originalName: "cover.png" }, "square");
    const web = await sharp(result.webBytes).metadata();

    expect(web.format).toBe("webp");
    expect(web.width).toBe(result.width);
    expect(web.height).toBe(result.height);
  });

  it("accepts a 16:9 landscape image", async () => {
    const result = await processArtworkAsset({ bytes: await png(1600, 900), originalName: "wide.png" }, "landscape");

    expect(result.width / result.height).toBeCloseTo(16 / 9, 3);
  });

  it("rejects an image submitted for the wrong shape", async () => {
    await expect(
      processArtworkAsset({ bytes: await png(1200, 800), originalName: "wrong.png" }, "square")
    ).rejects.toMatchObject({
      code: "INVALID_ASPECT_RATIO",
    } satisfies Partial<ArtworkAssetError>);
  });

  it("rejects invalid bytes", async () => {
    await expect(
      processArtworkAsset({ bytes: Buffer.from("not an image"), originalName: "fake.jpg" }, "square")
    ).rejects.toMatchObject({
      code: "INVALID_FILE",
    } satisfies Partial<ArtworkAssetError>);
  });

  it("writes assets with shared-group permissions under a restrictive umask", async () => {
    const square = await processArtworkAsset(
      { bytes: await png(800, 800), originalName: "square.png" },
      "square"
    );
    const landscape = await processArtworkAsset(
      { bytes: await png(1600, 900), originalName: "landscape.png" },
      "landscape"
    );
    const originalUmask = process.umask(0o077);

    try {
      const candidateDir = await writeArtworkCandidateAssets({
        catalogId: "20260919_120000",
        eventId: 7,
        artworkId: "00000000-0000-4000-8000-000000000007",
        square,
        landscape,
      });
      const eventDir = path.dirname(candidateDir);
      const [eventStat, candidateStat, squareStat, landscapeStat, squareWebStat, landscapeWebStat] = await Promise.all([
        fs.stat(eventDir),
        fs.stat(candidateDir),
        fs.stat(path.join(candidateDir, "square.png")),
        fs.stat(path.join(candidateDir, "landscape.png")),
        fs.stat(path.join(candidateDir, "square.web.webp")),
        fs.stat(path.join(candidateDir, "landscape.web.webp")),
      ]);

      expect(eventStat.mode & 0o7777).toBe(0o2770);
      expect(candidateStat.mode & 0o7777).toBe(0o2770);
      expect(squareStat.mode & 0o777).toBe(0o660);
      expect(landscapeStat.mode & 0o777).toBe(0o660);
      expect(squareWebStat.mode & 0o777).toBe(0o660);
      expect(landscapeWebStat.mode & 0o777).toBe(0o660);
    } finally {
      process.umask(originalUmask);
    }
  });

  it("backfills missing WebP copies without touching originals and skips finished ones", async () => {
    const catalogId = "20260919_120000";
    const artworkDir = path.join(resolveEventArtworksPath(catalogId), "7", "00000000-0000-4000-8000-000000000007");
    const incompleteDir = path.join(resolveEventArtworksPath(catalogId), "7", ".tmp-in-progress");
    await fs.mkdir(artworkDir, { recursive: true });
    await fs.mkdir(incompleteDir, { recursive: true });
    const squareBytes = await png(800, 800);
    await fs.writeFile(path.join(artworkDir, "square.png"), squareBytes);
    await fs.writeFile(
      path.join(artworkDir, "landscape.jpg"),
      await sharp(await png(1600, 900)).jpeg().toBuffer()
    );
    await fs.writeFile(path.join(incompleteDir, "square.png"), squareBytes);

    await expect(backfillArtworkWebAssets(catalogId)).resolves.toEqual({ created: 2, existing: 0, failed: [] });
    expect((await sharp(path.join(artworkDir, "square.web.webp")).metadata()).format).toBe("webp");
    expect((await sharp(path.join(artworkDir, "landscape.web.webp")).metadata()).format).toBe("webp");
    expect(await fs.readFile(path.join(artworkDir, "square.png"))).toEqual(squareBytes);
    await expect(fs.stat(path.join(incompleteDir, "square.web.webp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(artworkDir)).toHaveLength(4);

    await expect(backfillArtworkWebAssets(catalogId)).resolves.toEqual({ created: 0, existing: 2, failed: [] });
  });

  it("gives the WebP copy the original's permission bits under a restrictive umask", async () => {
    const catalogId = "20260919_120000";
    const artworkDir = path.join(resolveEventArtworksPath(catalogId), "7", "00000000-0000-4000-8000-000000000007");
    await fs.mkdir(artworkDir, { recursive: true });
    const squarePath = path.join(artworkDir, "square.png");
    const landscapePath = path.join(artworkDir, "landscape.png");
    await fs.writeFile(squarePath, await png(800, 800));
    await fs.writeFile(landscapePath, await png(1600, 900));
    await fs.chmod(squarePath, 0o640);
    await fs.chmod(landscapePath, 0o664);
    const originalUmask = process.umask(0o077);

    try {
      await backfillArtworkWebAssets(catalogId);
    } finally {
      process.umask(originalUmask);
    }

    const [square, landscape, original] = await Promise.all([
      fs.stat(path.join(artworkDir, "square.web.webp")),
      fs.stat(path.join(artworkDir, "landscape.web.webp")),
      fs.stat(squarePath),
    ]);
    expect(square.mode & 0o777).toBe(0o640);
    expect(landscape.mode & 0o777).toBe(0o664);
    expect(square.gid).toBe(original.gid);
  });

  it("reports an original that cannot be converted", async () => {
    const catalogId = "20260919_120000";
    const artworkDir = path.join(resolveEventArtworksPath(catalogId), "7", "00000000-0000-4000-8000-000000000007");
    await fs.mkdir(artworkDir, { recursive: true });
    await fs.writeFile(path.join(artworkDir, "square.png"), "not an image");

    const result = await backfillArtworkWebAssets(catalogId);

    expect(result).toMatchObject({ created: 0, existing: 0 });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatch(
      new RegExp(`^${path.join("7", "00000000-0000-4000-8000-000000000007", "square")}: .+`)
    );
  });

  it("ignores stray files beside event and artwork directories when backfilling", async () => {
    const catalogId = "20260919_120000";
    const eventsRoot = resolveEventArtworksPath(catalogId);
    const artworkDir = path.join(eventsRoot, "7", "00000000-0000-4000-8000-000000000007");
    await fs.mkdir(artworkDir, { recursive: true });
    await fs.writeFile(path.join(eventsRoot, "notes.txt"), "stray");
    await fs.writeFile(path.join(eventsRoot, "7", "stray.txt"), "stray");
    await fs.writeFile(path.join(artworkDir, "square.png"), await png(800, 800));

    await expect(backfillArtworkWebAssets(catalogId)).resolves.toEqual({ created: 1, existing: 0, failed: [] });
  });

  it("fails loudly when the catalog has no artwork directory", async () => {
    await expect(backfillArtworkWebAssets("20260919_120000")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns no staging record when the event artwork directory is absent", async () => {
    await expect(stageEventArtworkAssetsRemoval("20260919_120000", 7)).resolves.toBeNull();
  });

  it("returns no asset when a artwork file is missing", async () => {
    const missingPath = path.join(resolveEventArtworksPath("20260919_120000"), "7", "artwork", "square.png");

    await expect(readArtworkAsset(missingPath)).resolves.toBeNull();
  });

  it("rejects staging a artwork directory that resolves outside the artwork root", async () => {
    const eventPath = path.join(resolveEventArtworksPath("20260919_120000"), "7");
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.symlink(outsideRoot, eventPath);

    await expect(stageEventArtworkAssetsRemoval("20260919_120000", 7)).rejects.toThrow("Invalid event artwork directory");
  });

  it("merges staged assets back when the live directory was recreated", async () => {
    const eventPath = path.join(resolveEventArtworksPath("20260919_120000"), "7");
    await fs.mkdir(path.join(eventPath, "old-artwork"), { recursive: true });
    await fs.writeFile(path.join(eventPath, "old-artwork", "square.png"), "old");
    const staged = await stageEventArtworkAssetsRemoval("20260919_120000", 7);
    expect(staged).not.toBeNull();

    await fs.mkdir(path.join(eventPath, "new-artwork"), { recursive: true });
    await fs.writeFile(path.join(eventPath, "new-artwork", "square.png"), "new");
    await restoreStagedEventArtworkAssets(staged!);

    await expect(fs.readFile(path.join(eventPath, "old-artwork", "square.png"), "utf8")).resolves.toBe("old");
    await expect(fs.readFile(path.join(eventPath, "new-artwork", "square.png"), "utf8")).resolves.toBe("new");
    await expect(fs.lstat(staged!.stagedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes a staged directory during finalization", async () => {
    const eventPath = path.join(resolveEventArtworksPath("20260919_120000"), "7");
    await fs.mkdir(eventPath, { recursive: true });
    const staged = await stageEventArtworkAssetsRemoval("20260919_120000", 7);

    await finalizeStagedEventArtworkAssetsRemoval(staged!);

    await expect(fs.lstat(staged!.stagedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
