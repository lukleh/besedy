import { describe, expect, it } from "vitest";
import { buildAudioUrl, type AudioSourceOption } from "@/lib/api/recording-urls";

const BASE = "/api/catalogs/cat/recordings/abc/audio";
const sources: AudioSourceOption[] = [
  { id: "archived", type: "archived", formats: ["webm", "aac"] },
  { id: "listening:mobile", type: "listening", variant: "mobile", formats: ["webm", "aac"] },
  { id: "listening:quiet", type: "listening", variant: "quiet", formats: ["webm"] },
];

describe("buildAudioUrl", () => {
  it("keeps the WebM URLs unchanged without preferAac", () => {
    expect(buildAudioUrl("cat", "abc", "archived", sources)).toBe(BASE);
    expect(buildAudioUrl("cat", "abc", "listening:mobile", sources)).toBe(
      `${BASE}?source=listening&variant=mobile`,
    );
  });

  it("asks for the AAC copy only when the source lists one", () => {
    const options = { preferAac: true };
    expect(buildAudioUrl("cat", "abc", "archived", sources, options)).toBe(`${BASE}?format=aac`);
    expect(buildAudioUrl("cat", "abc", "listening:mobile", sources, options)).toBe(
      `${BASE}?source=listening&variant=mobile&format=aac`,
    );
    expect(buildAudioUrl("cat", "abc", "listening:quiet", sources, options)).toBe(
      `${BASE}?source=listening&variant=quiet`,
    );
  });

  it("falls back to the WebM before the sources are known", () => {
    expect(buildAudioUrl("cat", "abc", "archived", [], { preferAac: true })).toBe(BASE);
  });
});
