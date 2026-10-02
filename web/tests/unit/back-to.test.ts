import { describe, expect, it } from "vitest";
import { currentOrigin, resolveBackToPath, withBackTo } from "@/lib/navigation/back-to";

describe("back-to links", () => {
  it("adds the origin to a link and keeps its query and hash", () => {
    expect(withBackTo("/catalog/c1/recording/h?seek=3#t", "/downloads")).toBe(
      "/catalog/c1/recording/h?seek=3&backTo=%2Fdownloads#t"
    );
  });

  it("records the origin without its own back target", () => {
    const params = new URLSearchParams("seek=3&backTo=%2Fdownloads");

    expect(currentOrigin("/catalog/c1/recording/h", params)).toBe(
      "/catalog/c1/recording/h?seek=3"
    );
    expect(currentOrigin("/catalog/c1", new URLSearchParams("backTo=%2Fdownloads"))).toBe(
      "/catalog/c1"
    );
  });

  it("round-trips an origin through the query string", () => {
    const href = withBackTo("/downloads", "/catalog/c1?tab=events");
    const backTo = new URL(href, "http://localhost").searchParams.get("backTo");

    expect(resolveBackToPath(backTo)).toBe("/catalog/c1?tab=events");
  });
});
