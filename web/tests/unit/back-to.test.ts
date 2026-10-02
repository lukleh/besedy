import { describe, expect, it } from "vitest";
import { currentOrigin, resolveBackToPath, withBackTo } from "@/lib/navigation/back-to";

describe("back-to links", () => {
  it("adds the origin to a link and keeps its query and hash", () => {
    expect(withBackTo("/catalog/c1/recording/h?seek=3#t", "/downloads")).toBe(
      "/catalog/c1/recording/h?seek=3&backTo=%2Fdownloads#t"
    );
    expect(withBackTo("/settings#notifications", "/catalog/c1")).toBe(
      "/settings?backTo=%2Fcatalog%2Fc1#notifications"
    );
  });

  it("keeps a query value that contains a question mark", () => {
    expect(withBackTo("/x?q=a?b#h#2", "/y")).toBe("/x?q=a%3Fb&backTo=%2Fy#h#2");
  });

  it("records the origin without its back target or one-shot parameters", () => {
    const params = new URLSearchParams(
      "seek=3&end=9&fromSearch=1&fromRadio=true&readOnly=events&backTo=%2Fdownloads&tab=events"
    );

    expect(currentOrigin("/catalog/c1/recording/h", params)).toBe(
      "/catalog/c1/recording/h?tab=events"
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

  it("rejects the offline shell warm-up request as an origin", () => {
    expect(resolveBackToPath("/downloads?warm=1")).toBeNull();
    expect(resolveBackToPath("/downloads")).toBe("/downloads");
  });
});
