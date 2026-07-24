import { describe, expect, it } from "vitest";
import {
  assertGoogleOAuthConfiguredForProduction,
  isGoogleOAuthConfigured,
} from "@/lib/auth/provider-config";

describe("auth provider config", () => {
  it("detects configured Google OAuth when both values are present", () => {
    expect(isGoogleOAuthConfigured("google-id", "google-secret")).toBe(true);
  });

  it("detects missing Google OAuth when one value is absent", () => {
    expect(isGoogleOAuthConfigured("google-id", "")).toBe(false);
    expect(isGoogleOAuthConfigured("", "google-secret")).toBe(false);
  });

  it("throws in production when Google OAuth is missing", () => {
    expect(() => assertGoogleOAuthConfiguredForProduction("production", "test", "google-id", "")).toThrow(
      "Google OAuth is required in production"
    );
  });

  it("throws when NODE_ENV is production and APP_ENV is unset", () => {
    expect(() => assertGoogleOAuthConfiguredForProduction(undefined, "production", "", "")).toThrow(
      "Google OAuth is required in production"
    );
  });

  it("does not throw outside production when Google OAuth is missing", () => {
    expect(() => assertGoogleOAuthConfiguredForProduction("development", "test", "", "")).not.toThrow();
    expect(() => assertGoogleOAuthConfiguredForProduction("test", "test", "", "")).not.toThrow();
  });
});
