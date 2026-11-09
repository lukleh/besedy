import { describe, expect, it } from "vitest";
import { normalizeWebVersion } from "@/lib/service-worker/version";

describe("current web fingerprint", () => {
  it("accepts only the current fingerprint contract", () => {
    const fingerprint = "web-v2-" + "a".repeat(40);
    expect(normalizeWebVersion(fingerprint)).toBe(fingerprint);
  });
  it.each([null, undefined, "unknown", "abc123", "web-v1-" + "a".repeat(40), "web-v2-short", "web-v2-" + "g".repeat(40)])("rejects unsupported identity %s", (version) => {
    expect(normalizeWebVersion(version)).toBeNull();
  });
});
