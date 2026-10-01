import { describe, expect, it } from "vitest";
import {
  downloadSourceId,
  hasAacCopyForPackage,
  isWebmPackage,
} from "@/lib/offline/audio-format-upgrade";

const BASE = "/api/catalogs/cat/recordings/" + "a".repeat(64) + "/audio";

describe("audio format upgrade", () => {
  it("maps a download's audio URL to its /audio/sources id", () => {
    expect(downloadSourceId(BASE)).toBe("archived");
    expect(downloadSourceId(`${BASE}?format=aac`)).toBe("archived");
    expect(downloadSourceId(`${BASE}?source=listening&variant=mobile`)).toBe("listening:mobile");
    expect(downloadSourceId(`${BASE}?source=listening`)).toBe("archived");
  });

  it("treats only complete packages without a format as WebM", () => {
    expect(isWebmPackage({ status: "complete", audioUrl: BASE })).toBe(true);
    expect(isWebmPackage({ status: "complete", audioUrl: `${BASE}?format=aac` })).toBe(false);
    expect(isWebmPackage({ status: "downloading", audioUrl: BASE })).toBe(false);
    expect(isWebmPackage({ status: "complete", audioUrl: null })).toBe(false);
  });

  it("flags a WebM package only when its own source lists the AAC copy", () => {
    const sources = [
      { id: "archived", formats: ["webm", "aac"] },
      { id: "listening:mobile", formats: ["webm"] },
    ];
    expect(hasAacCopyForPackage({ status: "complete", audioUrl: BASE }, sources)).toBe(true);
    expect(
      hasAacCopyForPackage(
        { status: "complete", audioUrl: `${BASE}?source=listening&variant=mobile` },
        sources
      )
    ).toBe(false);
    expect(
      hasAacCopyForPackage({ status: "complete", audioUrl: `${BASE}?format=aac` }, sources)
    ).toBe(false);
    expect(hasAacCopyForPackage({ status: "complete", audioUrl: BASE }, [])).toBe(false);
  });
});
