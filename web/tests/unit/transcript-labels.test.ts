import { describe, it, expect } from "vitest";
import {
  formatModelLabel,
  splitModelKey,
  trimModelComponent,
} from "@/lib/transcript-labels";

describe("transcript label helpers", () => {
  it("splits backend keys into workflow and model", () => {
    expect(splitModelKey("faster-whisper/large-v3@silero_vad_v6")).toEqual({
      workflow: "faster-whisper",
      model: "large-v3@silero_vad_v6",
    });
  });

  it("keeps two-component models unchanged under the cap", () => {
    expect(trimModelComponent("large-v3@silero_vad_v6")).toBe("large-v3@silero_vad_v6");
  });

  it("keeps the language component so variants stay distinguishable", () => {
    expect(trimModelComponent("large-v3@silero@lang-auto")).toBe("large-v3@silero@lang-auto");
    expect(trimModelComponent("large-v3@silero_vad_v6@lang-en")).toBe(
      "large-v3@silero_v...@lang-en"
    );
  });

  it("renders distinct labels for language variants of the same model", () => {
    const legacy = formatModelLabel("faster-whisper/large-v3@silero_vad_v6");
    const english = formatModelLabel("faster-whisper/large-v3@silero_vad_v6@lang-en");
    expect(legacy).not.toBe(english);
    expect(english).toContain("@lang-en");
  });

  it("truncates long model names without a language component", () => {
    expect(trimModelComponent("a".repeat(40))).toBe(`${"a".repeat(25)}...`);
  });
});
