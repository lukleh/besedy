import { existsSync } from "fs";
import { config } from "dotenv";
import { getWebEnvSearchPaths, type BesedyWebEnvMode } from "@/lib/runtime-paths";

export type ScriptMode = BesedyWebEnvMode;

export function resolveScriptEnvFilePath(mode: ScriptMode): string | null {
  for (const candidate of getWebEnvSearchPaths(mode)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function loadScriptEnv(mode: ScriptMode): string | null {
  const envPath = resolveScriptEnvFilePath(mode);
  if (envPath) {
    config({ path: envPath, quiet: true });
  }
  return envPath;
}

export function getDatabaseUrlOrThrow(): string {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    return connectionString;
  }
  throw new Error(
    "DATABASE_URL is required. Set it in the selected env file or export DATABASE_URL."
  );
}

/**
 * Resolve a database URL for operator scripts that run on the host while the
 * application DATABASE_URL names the Compose-only `db` service. DB_PORT uses
 * the same host binding syntax as docker-compose.yml (for example
 * `127.0.0.1:5432` or just `5432`).
 */
export function resolveHostDatabaseUrl(
  connectionString: string,
  publishedAddress: string | undefined
): string {
  const binding = publishedAddress?.trim();
  if (!binding) return connectionString;

  let host = "127.0.0.1";
  let port = binding;
  if (!/^\d+$/.test(binding)) {
    const ipv6Match = binding.match(/^\[([^\]]+)]:(\d+)$/);
    const hostMatch = binding.match(/^([^:]+):(\d+)$/);
    if (ipv6Match) {
      [, host, port] = ipv6Match;
    } else if (hostMatch) {
      [, host, port] = hostMatch;
    } else {
      throw new Error(`DB_PORT must be a port or host:port binding, received: ${binding}`);
    }
  }

  const portNumber = Number(port);
  if (
    !Number.isSafeInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65535
  ) {
    throw new Error(`DB_PORT contains an invalid port: ${port}`);
  }
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";

  const url = new URL(connectionString);
  const serializedHost = host.includes(":") ? `[${host}]` : host;
  url.host = `${serializedHost}:${portNumber}`;
  return url.toString();
}

export function getHostDatabaseUrlOrThrow(): string {
  return resolveHostDatabaseUrl(getDatabaseUrlOrThrow(), process.env.DB_PORT);
}

export function redactDatabaseUrl(connectionString: string): string {
  const schemeSeparatorIndex = connectionString.indexOf("://");
  if (schemeSeparatorIndex === -1) {
    return connectionString;
  }

  const authorityStart = schemeSeparatorIndex + 3;
  const authorityRemainder = connectionString.slice(authorityStart);
  const authorityEndOffset = authorityRemainder.search(/[/?#]/);
  const authorityEnd =
    authorityEndOffset === -1 ? connectionString.length : authorityStart + authorityEndOffset;
  const authority = connectionString.slice(authorityStart, authorityEnd);

  // Credentials end at the last @ in authority. Everything after it is host[:port].
  const credentialsEnd = authority.lastIndexOf("@");
  if (credentialsEnd === -1) {
    return connectionString;
  }

  const userInfo = authority.slice(0, credentialsEnd);
  const hostInfo = authority.slice(credentialsEnd + 1);
  const passwordSeparator = userInfo.indexOf(":");
  if (passwordSeparator === -1) {
    return connectionString;
  }

  const username = userInfo.slice(0, passwordSeparator);
  const password = userInfo.slice(passwordSeparator + 1);
  if (!password) {
    return connectionString;
  }

  const redactedAuthority = `${username}:****@${hostInfo}`;
  return `${connectionString.slice(0, authorityStart)}${redactedAuthority}${connectionString.slice(authorityEnd)}`;
}
