type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
};

export function getGoogleOAuthConfig(
  googleClientId = process.env.AUTH_GOOGLE_ID,
  googleClientSecret = process.env.AUTH_GOOGLE_SECRET
): GoogleOAuthConfig | null {
  if (!googleClientId || !googleClientSecret) {
    return null;
  }

  return {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
  };
}

export function isGoogleOAuthConfigured(
  googleClientId = process.env.AUTH_GOOGLE_ID,
  googleClientSecret = process.env.AUTH_GOOGLE_SECRET
): boolean {
  return getGoogleOAuthConfig(googleClientId, googleClientSecret) !== null;
}

export function assertGoogleOAuthConfiguredForProduction(
  appEnv = process.env.APP_ENV,
  nodeEnv = process.env.NODE_ENV,
  googleClientId = process.env.AUTH_GOOGLE_ID,
  googleClientSecret = process.env.AUTH_GOOGLE_SECRET
): void {
  const isProductionEnvironment = appEnv === "production" || (!appEnv && nodeEnv === "production");
  if (isProductionEnvironment && !isGoogleOAuthConfigured(googleClientId, googleClientSecret)) {
    throw new Error(
      "Google OAuth is required in production. Set AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET."
    );
  }
}
