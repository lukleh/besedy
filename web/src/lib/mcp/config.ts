const DEFAULT_AUTH_ORIGIN = "http://localhost:3001";

export const MCP_READ_SCOPE = "besedy:read";
export const MCP_AUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  MCP_READ_SCOPE,
] as const;

export function getMcpResourceUrl(): string {
  const configuredAuthUrl = process.env.AUTH_URL?.trim() || DEFAULT_AUTH_ORIGIN;
  return new URL("/api/mcp", configuredAuthUrl).toString();
}
