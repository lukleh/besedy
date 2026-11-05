import { describe, expect, it } from "vitest";
import { buildAudioUrl, buildCorrectionPagePath, buildCorrectionSpansUrl, type AudioSourceOption } from "@/lib/api/recording-urls";

const BASE = "/api/catalogs/cat/recordings/abc/audio";
const sources: AudioSourceOption[] = [
  { id: "archived", type: "archived", formats: ["webm", "aac"] },
];

describe("buildAudioUrl", () => {
  it("keeps the WebM URLs unchanged without preferAac", () => {
    expect(buildAudioUrl("cat", "abc", "archived", sources)).toBe(BASE);
  });

  it("asks for the AAC copy only when the source lists one", () => {
    const options = { preferAac: true };
    expect(buildAudioUrl("cat", "abc", "archived", sources, options)).toBe(`${BASE}?format=aac`);
    expect(
      buildAudioUrl("cat", "abc", "archived", [{ id: "archived", type: "archived", formats: ["webm"] }], options),
    ).toBe(BASE);
  });

  it("falls back to the WebM before the sources are known", () => {
    expect(buildAudioUrl("cat", "abc", "archived", [], { preferAac: true })).toBe(BASE);
  });
});

describe("buildCorrectionPagePath", () => {
  const path = "/catalog/cat/recording/abc/correction";

  it.each([undefined, null, ""])("keeps the existing path when the segment is %s", (spanId) => {
    expect(buildCorrectionPagePath("cat", "abc", spanId)).toBe(path);
  });

  it("links directly to an opaque correction segment", () => {
    expect(buildCorrectionPagePath("cat", "abc", "span-123")).toBe(`${path}?segment=span-123`);
  });

  it("encodes reserved characters inside one segment query value", () => {
    const spanId = "segment /?&callbackUrl=https://example.com/#č";
    const url = new URL(buildCorrectionPagePath("cat", "abc", spanId), "https://besedy.org");

    expect(url.pathname).toBe(path);
    expect(url.searchParams.get("segment")).toBe(spanId);
    expect([...url.searchParams.keys()]).toEqual(["segment"]);
    expect(url.hash).toBe("");
  });
});

describe("buildCorrectionSpansUrl", () => {
  const base = "/api/catalogs/cat/recordings/abc/correction/spans";

  it("pages by offset", () => {
    expect(buildCorrectionSpansUrl("cat", "abc", { offset: 200, limit: 200 })).toBe(`${base}?offset=200&limit=200`);
  });

  it("asks for the page holding a linked segment", () => {
    expect(buildCorrectionSpansUrl("cat", "abc", { segment: "a&b", limit: 200 })).toBe(`${base}?segment=a%26b&limit=200`);
  });
});
