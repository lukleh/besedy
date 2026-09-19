import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PosterAssetError, processPosterAsset } from "@/lib/event-poster-storage";

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
});
