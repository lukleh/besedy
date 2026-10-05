import { describe, expect, it } from "vitest";
import { buildAudioUrl, type AudioSourceOption } from "@/lib/api/recording-urls";

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
