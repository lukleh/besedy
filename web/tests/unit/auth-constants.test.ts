import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AUTH_COOKIE_PREFIX, getAuthSecret } from "@/lib/auth/constants";

describe("AUTH_COOKIE_PREFIX", () => {
  it("should be 'besedy'", () => {
    expect(AUTH_COOKIE_PREFIX).toBe("besedy");
  });
});

describe("getAuthSecret", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return AUTH_SECRET", () => {
    process.env.AUTH_SECRET = "auth-secret-value";

    expect(getAuthSecret()).toBe("auth-secret-value");
  });

  it("should throw when AUTH_SECRET is not set", () => {
    delete process.env.AUTH_SECRET;

    expect(() => getAuthSecret()).toThrow(/AUTH_SECRET is required/i);
  });

  it("should not read BETTER_AUTH_SECRET in its place", () => {
    delete process.env.AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-value";

    expect(() => getAuthSecret()).toThrow(/AUTH_SECRET is required/i);
  });

  it("should handle empty string AUTH_SECRET", () => {
    process.env.AUTH_SECRET = "";

    expect(() => getAuthSecret()).toThrow(/AUTH_SECRET is required/i);
  });
});
