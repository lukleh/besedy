import SignInPageClient from "./signin-page-client";

export default async function SignInPage() {
  const appEnv = process.env.APP_ENV;
  const hasMockOAuth =
    Boolean(process.env.OAUTH_MOCK_URL?.trim()) &&
    (appEnv === "development" || appEnv === "test");

  // Do not server-redirect from sign-in page; middleware and client status checks
  // handle auth routing and avoid signin/catalog redirect loops on stale sessions.
  return <SignInPageClient hasMockOAuth={hasMockOAuth} />;
}
