import { describe, expect, it } from "vitest";
import { getOAuthErrorMessage } from "@/lib/auth/oauth-errors";

const translate = (key: string) => `translated:${key}`;

describe("getOAuthErrorMessage", () => {
  it.each(["account_not_linked", "account_already_linked_to_different_user"])(
    "translates the account-link conflict %s",
    (error) => {
      expect(getOAuthErrorMessage(error, null, translate)).toBe(
        "translated:errors.accountLinked"
      );
    }
  );

  it("translates provider authorization cancellation", () => {
    expect(getOAuthErrorMessage("access_denied", "The user cancelled", translate)).toBe(
      "translated:errors.accessDenied"
    );
  });

  it.each([
    "state_not_found",
    "state_mismatch",
    "state_invalid",
    "invalid_callback_request",
    "invalid_code",
    "issuer_mismatch",
    "email_not_verified",
    "unable_to_link_account",
    "email_does_not_match",
    "unable_to_create_session",
  ])("translates callback failure %s without claiming an account conflict", (error) => {
    expect(getOAuthErrorMessage(error, null, translate)).toBe(
      "translated:errors.oauthCallback"
    );
  });

  it("preserves unknown callback errors", () => {
    expect(getOAuthErrorMessage("provider_specific_error", "Provider detail", translate)).toBe(
      "provider_specific_error"
    );
  });

  it("uses the description when no error code is present", () => {
    expect(getOAuthErrorMessage(null, "Provider diagnostic", translate)).toBe(
      "Provider diagnostic"
    );
    expect(getOAuthErrorMessage(null, "state_not_found", translate)).toBe(
      "translated:errors.oauthCallback"
    );
  });

  it("does not invent an error when the callback succeeded", () => {
    expect(getOAuthErrorMessage(null, null, translate)).toBeNull();
    expect(getOAuthErrorMessage("", "", translate)).toBeNull();
  });
});
