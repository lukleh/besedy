import McpSignIn from "./mcp-signin";

export default function McpSignInPage() {
  const appEnv = process.env.APP_ENV;
  const hasMockOAuth =
    Boolean(process.env.OAUTH_MOCK_URL?.trim()) &&
    (appEnv === "development" || appEnv === "test");

  return <McpSignIn hasMockOAuth={hasMockOAuth} />;
}
