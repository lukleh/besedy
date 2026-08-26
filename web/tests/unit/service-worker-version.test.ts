import { describe, expect, it } from "vitest";
import { selectObservedWebVersion } from "@/lib/service-worker/version";

describe("selectObservedWebVersion", () => {
  it("does not compare a fingerprinted client with a legacy commit identity", () => {
    expect(selectObservedWebVersion(null, "abc123", "web-v2-client")).toBeNull();
    expect(selectObservedWebVersion("abc123", "abc123", "web-v2-client")).toBeNull();
  });

  it("accepts a fingerprint from a fingerprinted server", () => {
    expect(selectObservedWebVersion("web-v2-server", "abc123", "web-v2-client")).toBe(
      "web-v2-server"
    );
  });

  it("keeps the commit fallback for legacy clients", () => {
    expect(selectObservedWebVersion(null, "abc123", "legacy-client")).toBe("abc123");
  });
});
