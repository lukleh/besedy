type OAuthErrorMessageKey =
  | "errors.accountLinked"
  | "errors.accessDenied"
  | "errors.oauthCallback";

// BetterAuth callback redirects use URL-safe codes in the `error` parameter.
const CALLBACK_FAILURE_CODES = new Set([
  "no_code",
  "oauth_provider_not_found",
  "issuer_missing",
  "issuer_mismatch",
  "invalid_code",
  "nonce_binding_missing",
  "unable_to_get_user_info",
  "no_callback_url",
  "unable_to_link_account",
  "email_does_not_match",
  "email_not_found",
  "email_not_verified",
  "invalid_callback_request",
  "state_not_found",
  "state_mismatch",
  "state_invalid",
  "internal_server_error",
  "unable_to_update_account",
  "signup_disabled",
  "unable_to_create_user",
  "unable_to_create_session",
]);

export function getOAuthErrorMessage(
  error: string | null,
  errorDescription: string | null,
  translate: (key: OAuthErrorMessageKey) => string
): string | null {
  const code = error || errorDescription;
  if (!code) {
    return null;
  }
  if (code === "account_not_linked" || code === "account_already_linked_to_different_user") {
    return translate("errors.accountLinked");
  }
  if (code === "access_denied") {
    return translate("errors.accessDenied");
  }
  if (CALLBACK_FAILURE_CODES.has(code)) {
    return translate("errors.oauthCallback");
  }
  return code;
}
