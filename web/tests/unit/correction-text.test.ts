import { describe, expect, it } from "vitest";
import {
  fingerprintContent,
  hashSpanText,
  normalizeSpanText,
} from "@/lib/correction/text";

describe("correction text normalization", () => {
  it("collapses whitespace runs and trims", () => {
    expect(normalizeSpanText("  a   b \t c  ")).toBe("a b c");
  });

  it("treats a line break inside one utterance as a space", () => {
    expect(normalizeSpanText("first\r\nsecond\rthird\nfourth")).toBe(
      "first second third fourth"
    );
  });

  it("canonicalizes the Unicode form", () => {
    const decomposed = "řekl";
    const composed = "řekl";

    expect(normalizeSpanText(decomposed)).toBe(normalizeSpanText(composed));
    expect(hashSpanText(normalizeSpanText(decomposed))).toBe(
      hashSpanText(normalizeSpanText(composed))
    );
  });

  it("keeps capitalization and punctuation, which carry meaning", () => {
    expect(normalizeSpanText("Ano, ale...")).toBe("Ano, ale...");
    expect(normalizeSpanText("ano ale")).not.toBe(normalizeSpanText("Ano ale"));
  });

  it("removes zero-width and non-breaking characters that would hide a difference", () => {
    expect(normalizeSpanText("a​b c")).toBe("a b c");
  });

  it("refuses an empty revision, because v1 has no intentional empty outcome", () => {
    expect(normalizeSpanText("   ")).toBe("");
    expect(normalizeSpanText("word")).toBe("word");
  });

  it("hashes content deterministically", () => {
    expect(fingerprintContent("abc")).toBe(fingerprintContent("abc"));
    expect(fingerprintContent("abc")).not.toBe(fingerprintContent("abd"));
    expect(hashSpanText("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
