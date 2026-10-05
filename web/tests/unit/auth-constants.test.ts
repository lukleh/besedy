import { describe, it, expect } from "vitest";
import { AUTH_COOKIE_PREFIX } from "@/lib/auth/constants";

describe("AUTH_COOKIE_PREFIX", () => {
  it("should be 'besedy'", () => {
    expect(AUTH_COOKIE_PREFIX).toBe("besedy");
  });
});
