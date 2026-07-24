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

  it("should return BETTER_AUTH_SECRET when set", () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-value";
    process.env.AUTH_SECRET = "auth-secret-value";

    // Re-import to get fresh function with new env
    const result = getAuthSecret();
    expect(result).toBe("better-auth-secret-value");
  });

  it("should return AUTH_SECRET when BETTER_AUTH_SECRET is not set", () => {
    delete process.env.BETTER_AUTH_SECRET;
    process.env.AUTH_SECRET = "auth-secret-value";

    const result = getAuthSecret();
    expect(result).toBe("auth-secret-value");
  });

  it("should throw when no env vars are set", () => {
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.AUTH_SECRET;

    expect(() => getAuthSecret()).toThrow(/AUTH_SECRET is required/i);
  });

  it("should prefer BETTER_AUTH_SECRET over AUTH_SECRET", () => {
    process.env.BETTER_AUTH_SECRET = "preferred-secret";
    process.env.AUTH_SECRET = "fallback-secret";

    const result = getAuthSecret();
    expect(result).toBe("preferred-secret");
  });

  it("should handle empty string BETTER_AUTH_SECRET", () => {
    process.env.BETTER_AUTH_SECRET = "";
    process.env.AUTH_SECRET = "fallback-secret";

    const result = getAuthSecret();
    // Empty string is falsy, so it should fall through to AUTH_SECRET
    expect(result).toBe("fallback-secret");
  });

  it("should handle empty string AUTH_SECRET", () => {
    delete process.env.BETTER_AUTH_SECRET;
    process.env.AUTH_SECRET = "";

    expect(() => getAuthSecret()).toThrow(/AUTH_SECRET is required/i);
  });
});
