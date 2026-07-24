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
