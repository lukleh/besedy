import path from "path";
import fs from "fs";
import { getPostersDir, getSourcesDir, getTextDataDir } from "../config";

/**
 * Path validation utilities to prevent directory traversal attacks.
 *
 * These utilities ensure that file paths accessed by the application
 * are within allowed directories (config text_data_dir, BESEDY_BASE_DIR,
 * and any additional mounted audio directories).
 */

/**
 * Get path mappings from environment variable.
 * Format: BESEDY_PATH_MAPPINGS=/host/path=/container/path,/other/host=/other/container
 *
 * Used to rewrite paths from CSV catalogs (which contain host paths)
 * to container paths (where files are actually mounted).
 */
function getPathMappings(): Array<{ from: string; to: string }> {
  const mappings = process.env.BESEDY_PATH_MAPPINGS;
  if (!mappings) return [];

  return mappings.split(",").map((mapping) => {
    const [from, to] = mapping.trim().split("=");
    return { from: from?.trim() || "", to: to?.trim() || "" };
  }).filter((m) => m.from && m.to);
}

/**
 * Rewrite a path using configured path mappings.
 * This translates host paths from CSV catalogs to container mount paths.
 *
 * @param filePath - The original path (possibly a host path)
 * @returns The rewritten path if a mapping matches, otherwise the original path
 */
export function rewritePath(filePath: string): string {
  const mappings = getPathMappings();

  for (const { from, to } of mappings) {
    // Use path boundary check to avoid matching /data2 when mapping /data
    if (filePath === from || filePath.startsWith(from + path.sep)) {
      return filePath.replace(from, to);
    }
  }

  return filePath;
}

/**
 * Helper to resolve a path, following symlinks if possible.
 */
function resolvePath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Async helper to resolve a path, following symlinks if possible.
 */
async function resolvePathAsync(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Get the list of allowed base directories.
 * Priority order:
 * 1. Config text_data_dir (from besedy.toml)
 * 2. BESEDY_BASE_DIR environment variable
 * 3. BESEDY_ALLOWED_PATHS environment variable (comma-separated)
 *
 * Returns resolved (real) paths with symlinks followed.
 */
export function getAllowedBaseDirs(): string[] {
  const dirs: string[] = [];

  // Config-based text data directory (primary)
  try {
    const textDataDir = getTextDataDir();
    dirs.push(resolvePath(textDataDir));
  } catch {
    // Config not available - continue with env-based paths
  }

  // Posters directory (if configured separately)
  try {
    const postersDir = getPostersDir();
    const resolved = resolvePath(postersDir);
    if (!dirs.includes(resolved)) {
      dirs.push(resolved);
    }
  } catch {
    // Ignore if config not available
  }

  // Recording sources directory (if configured separately)
  try {
    const sourcesDir = getSourcesDir();
    const resolved = resolvePath(sourcesDir);
    if (!dirs.includes(resolved)) {
      dirs.push(resolved);
    }
  } catch {
    // Ignore if config not available
  }

  // BESEDY_BASE_DIR environment variable
  const baseDir = process.env.BESEDY_BASE_DIR;
  if (baseDir) {
    dirs.push(resolvePath(baseDir));
  }

  // Additional allowed paths (comma-separated)
  // Useful for mounted audio archives outside primary directories
  const additionalPaths = process.env.BESEDY_ALLOWED_PATHS;
  if (additionalPaths) {
    for (const p of additionalPaths.split(",")) {
      const trimmed = p.trim();
      if (trimmed) {
        dirs.push(resolvePath(trimmed));
      }
    }
  }

  return dirs;
}

/**
 * Async variant of getAllowedBaseDirs to avoid blocking filesystem calls
 * in request handlers.
 */
export async function getAllowedBaseDirsAsync(): Promise<string[]> {
  const dirs: string[] = [];

  try {
    const textDataDir = getTextDataDir();
    dirs.push(await resolvePathAsync(textDataDir));
  } catch {
    // Config not available - continue with env-based paths
  }

  try {
    const postersDir = getPostersDir();
    const resolved = await resolvePathAsync(postersDir);
    if (!dirs.includes(resolved)) {
      dirs.push(resolved);
    }
  } catch {
    // Ignore if config not available
  }

  try {
    const sourcesDir = getSourcesDir();
    const resolved = await resolvePathAsync(sourcesDir);
    if (!dirs.includes(resolved)) {
      dirs.push(resolved);
    }
  } catch {
    // Ignore if config not available
  }

  const baseDir = process.env.BESEDY_BASE_DIR;
  if (baseDir) {
    dirs.push(await resolvePathAsync(baseDir));
  }

  const additionalPaths = process.env.BESEDY_ALLOWED_PATHS;
  if (additionalPaths) {
    for (const p of additionalPaths.split(",")) {
      const trimmed = p.trim();
      if (trimmed) {
        dirs.push(await resolvePathAsync(trimmed));
      }
    }
  }

  return dirs;
}

/**
 * Validate that a path is within one of the allowed base directories.
 * Prevents directory traversal attacks by:
 * 1. Resolving symlinks (follows all symlinks to get the real path)
 * 2. Ensuring the real path is within allowed boundaries
 *
 * @param filePath - The path to validate (can be relative or absolute)
 * @returns Object with validation result and details
 */
export function validatePath(filePath: string): {
  valid: boolean;
  resolvedPath: string;
  reason?: string;
} {
  let resolvedPath: string;

  try {
    // Resolve symlinks and normalize path using fs.realpathSync
    // This follows all symlinks to get the actual file location
    resolvedPath = fs.realpathSync(filePath);
  } catch {
    // File doesn't exist or permission denied
    // Fall back to path.resolve for error message, but mark as invalid
    return {
      valid: false,
      resolvedPath: path.resolve(filePath),
      reason: "Path does not exist or is not accessible",
    };
  }

  const allowedDirs = getAllowedBaseDirs();

  // If no allowed directories configured, reject all paths
  if (allowedDirs.length === 0) {
    return {
      valid: false,
      resolvedPath,
      reason: "No allowed directories configured (BESEDY_BASE_DIR not set)",
    };
  }

  // Check if path starts with any allowed directory
  const isAllowed = allowedDirs.some((baseDir) => {
    // Ensure path is within directory (not just a prefix match)
    // e.g., /data/foo should match /data but not /data2
    return (
      resolvedPath === baseDir || resolvedPath.startsWith(baseDir + path.sep)
    );
  });

  if (!isAllowed) {
    return {
      valid: false,
      resolvedPath,
      reason: `Path outside allowed directories: ${allowedDirs.join(", ")}`,
    };
  }

  return {
    valid: true,
    resolvedPath,
  };
}

/**
 * Async variant of validatePath for request handlers that should avoid
 * synchronous filesystem calls.
 */
export async function validatePathAsync(filePath: string): Promise<{
  valid: boolean;
  resolvedPath: string;
  reason?: string;
}> {
  let resolvedPath: string;

  try {
    resolvedPath = await fs.promises.realpath(filePath);
  } catch {
    return {
      valid: false,
      resolvedPath: path.resolve(filePath),
      reason: "Path does not exist or is not accessible",
    };
  }

  const allowedDirs = await getAllowedBaseDirsAsync();
  if (allowedDirs.length === 0) {
    return {
      valid: false,
      resolvedPath,
      reason: "No allowed directories configured (BESEDY_BASE_DIR not set)",
    };
  }

  const isAllowed = allowedDirs.some((baseDir) => {
    return resolvedPath === baseDir || resolvedPath.startsWith(baseDir + path.sep);
  });

  if (!isAllowed) {
    return {
      valid: false,
      resolvedPath,
      reason: `Path outside allowed directories: ${allowedDirs.join(", ")}`,
    };
  }

  return {
    valid: true,
    resolvedPath,
  };
}

/**
 * Validate a path and throw if invalid.
 * Use this in API routes for concise error handling.
 *
 * @param filePath - The path to validate
 * @throws Error if path is outside allowed directories
 * @returns The resolved (canonical) path
 */
export function requireValidPath(filePath: string): string {
  const result = validatePath(filePath);
  if (!result.valid) {
    throw new PathValidationError(result.reason || "Invalid path", filePath);
  }
  return result.resolvedPath;
}

/**
 * Custom error for path validation failures
 */
export class PathValidationError extends Error {
  constructor(
    message: string,
    public readonly path: string
  ) {
    super(message);
    this.name = "PathValidationError";
  }
}
