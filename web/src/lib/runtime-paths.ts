import os from "node:os";
import path from "node:path";

export type BesedyWebEnvMode = "development" | "production" | "test";

function resolveHomeDir(): string {
  const home = process.env.HOME?.trim();
  return home || os.homedir();
}

function normalizePath(rawPath: string, cwd = process.cwd()): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function resolveBesedyXdgRoot(
  overrideEnv: string,
  xdgEnv: string,
  fallbackSegments: string[],
  cwd = process.cwd()
): string {
  const override = process.env[overrideEnv]?.trim();
  if (override) {
    return normalizePath(override, cwd);
  }

  const xdgRoot = process.env[xdgEnv]?.trim();
  const baseRoot = xdgRoot
    ? normalizePath(xdgRoot, cwd)
    : path.join(resolveHomeDir(), ...fallbackSegments);
  return path.join(baseRoot, "lukleh", "besedy");
}

export function resolveBesedyConfigHome(cwd = process.cwd()): string {
  const xdgRoot = process.env.XDG_CONFIG_HOME?.trim();
  const baseRoot = xdgRoot
    ? normalizePath(xdgRoot, cwd)
    : path.join(resolveHomeDir(), ".config");
  return path.join(baseRoot, "lukleh", "besedy");
}

export function resolveBesedyStateHome(cwd = process.cwd()): string {
  return resolveBesedyXdgRoot(
    "BESEDY_STATE_HOME",
    "XDG_STATE_HOME",
    [".local", "state"],
    cwd
  );
}

export function resolveBesedyCacheHome(cwd = process.cwd()): string {
  return resolveBesedyXdgRoot(
    "BESEDY_CACHE_HOME",
    "XDG_CACHE_HOME",
    [".cache"],
    cwd
  );
}

export function resolveBesedyWebStateDir(
  ...parts: string[]
): string {
  return path.join(resolveBesedyStateHome(), "web", ...parts);
}

export function resolveBesedyWebCacheDir(
  ...parts: string[]
): string {
  return path.join(resolveBesedyCacheHome(), "web", ...parts);
}

function envFileSuffix(mode: BesedyWebEnvMode): string {
  switch (mode) {
    case "development":
      return "dev";
    case "production":
      return "prod";
    case "test":
      return "test";
  }
}

function envOverrideName(mode: BesedyWebEnvMode): string {
  switch (mode) {
    case "development":
      return "BESEDY_WEB_ENV_DEV";
    case "production":
      return "BESEDY_WEB_ENV_PROD";
    case "test":
      return "BESEDY_WEB_ENV_TEST";
  }
}

export function getWebEnvSearchPaths(
  mode: BesedyWebEnvMode,
  cwd = process.cwd()
): string[] {
  const suffix = envFileSuffix(mode);
  const homeFileName = `web.env.${suffix}`;
  const override = process.env[envOverrideName(mode)]?.trim();

  if (override) {
    return [normalizePath(override, cwd)];
  }

  return [path.join(resolveBesedyConfigHome(cwd), homeFileName)];
}

export function getBesedyConfigSearchPaths(cwd = process.cwd()): string[] {
  const override = process.env.BESEDY_CONFIG?.trim();
  if (override) {
    return [normalizePath(override, cwd)];
  }

  return [path.join(resolveBesedyConfigHome(cwd), "besedy.toml")];
}
