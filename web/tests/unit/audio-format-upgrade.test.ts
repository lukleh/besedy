import { describe, expect, it } from "vitest";
import {
  hasAacCopyForPackage,
  isWebmPackage,
} from "@/lib/offline/audio-format-upgrade";

const BASE = "/api/catalogs/cat/recordings/" + "a".repeat(64) + "/audio";

describe("audio format upgrade", () => {
  it("treats only complete packages without a format as WebM", () => {
    expect(isWebmPackage({ status: "complete", audioUrl: BASE })).toBe(true);
    expect(isWebmPackage({ status: "complete", audioUrl: `${BASE}?format=aac` })).toBe(false);
    expect(isWebmPackage({ status: "downloading", audioUrl: BASE })).toBe(false);
    expect(isWebmPackage({ status: "complete", audioUrl: null })).toBe(false);
  });

  it("flags a WebM package only when the archived source lists the AAC copy", () => {
    const sources = [{ id: "archived", formats: ["webm", "aac"] }];
    expect(hasAacCopyForPackage({ status: "complete", audioUrl: BASE }, sources)).toBe(true);
    // A package of the retired listening source plays the archived recording.
    expect(
      hasAacCopyForPackage(
        { status: "complete", audioUrl: `${BASE}?source=listening&variant=mobile` },
        sources
      )
    ).toBe(true);
    expect(
      hasAacCopyForPackage({ status: "complete", audioUrl: BASE }, [
        { id: "archived", formats: ["webm"] },
      ])
    ).toBe(false);
    expect(
      hasAacCopyForPackage({ status: "complete", audioUrl: `${BASE}?format=aac` }, sources)
    ).toBe(false);
    expect(hasAacCopyForPackage({ status: "complete", audioUrl: BASE }, [])).toBe(false);
  });
});
