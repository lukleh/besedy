import fs from "fs";
import path from "path";
import { parse as parseToml } from "@iarna/toml";
import { getBesedyConfigSearchPaths } from "@/lib/runtime-paths";

interface BesedyPathsConfig {
  text_data_dir: string;
  transcripts_dir: string;
  audio_artifacts_dir?: string;
  posters_dir?: string;
  sources_dir?: string;
  uploads_dir?: string;
  corrections_dir?: string;
}

interface BesedyWebConfig {
  superadmin_email?: string;
  deep_search_default_instructions?: string;
}

interface BesedyConfig {
  paths: BesedyPathsConfig;
  web?: BesedyWebConfig;
}

let cachedConfig: BesedyConfig | null = null;

/**
 * Load and cache besedy.toml configuration.
 * Throws if config file is not found.
 */
export function getBesedyConfig(): BesedyConfig {
  if (cachedConfig) return cachedConfig;

  const searchPaths = getBesedyConfigSearchPaths();

  for (const configPath of searchPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        cachedConfig = parseToml(content) as unknown as BesedyConfig;
        console.log("[config] Loaded besedy.toml from:", configPath);
        return cachedConfig;
      }
    } catch (e) {
      console.error("[config] Failed to parse", configPath, e);
    }
  }

  throw new Error(
    `besedy.toml not found. Searched: ${searchPaths.join(", ")}. ` +
      "Set BESEDY_CONFIG or create ~/.config/lukleh/besedy/besedy.toml."
  );
}

/**
 * Get the text data directory from config.
 */
export function getTextDataDir(): string {
  return getBesedyConfig().paths.text_data_dir;
}

/**
 * Get the posters directory. The application config is authoritative when it
 * is available. Host-run operator tools fall back to POSTERS_DIR because the
 * selected production environment points BESEDY_CONFIG at a container-only
 * path.
 */
export function getPostersDir(): string {
  try {
    const config = getBesedyConfig();
    return config.paths.posters_dir || config.paths.text_data_dir;
  } catch (configError) {
    const environmentPath = process.env.POSTERS_DIR?.trim();
    if (environmentPath) return environmentPath;

    throw configError;
  }
}

/**
 * Get recording sources directory from config (falls back to text_data_dir).
 */
export function getSourcesDir(): string {
  const config = getBesedyConfig();
  const sourcesDir = config.paths.sources_dir?.trim();
  if (!sourcesDir) {
    throw new Error("sources_dir is required in besedy.toml for recording sources.");
  }
  return sourcesDir;
}

/**
 * Get the admin upload (ingest) directory from config.
 */
export function getUploadsDir(): string {
  const config = getBesedyConfig();
  const uploadsDir = config.paths.uploads_dir?.trim();
  if (!uploadsDir) {
    throw new Error("uploads_dir is required in besedy.toml for recording ingest.");
  }
  return uploadsDir;
}

/**
 * Get the correction workspace directory from config.
 *
 * Correction artifacts are written while work is in progress, so they cannot
 * live inside a transcript generation, which ADR 0002 keeps immutable. The
 * default is a sibling of the catalogs under `text_data_dir`, which keeps it
 * inside the paths the application is already allowed to read.
 */
export function getCorrectionsDir(): string {
  const config = getBesedyConfig();
  const correctionsDir = config.paths.corrections_dir?.trim();
  if (correctionsDir) return correctionsDir;
  return path.join(config.paths.text_data_dir, "corrections");
}

/**
 * Clear cached config (useful for testing).
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get the superadmin email from config, or null if not configured.
 * Used to auto-create superadmin on first OAuth login.
 */
export function getSuperadminEmail(): string | null {
  const config = getBesedyConfig();
  const email = config.web?.superadmin_email?.toLowerCase().trim();
  return email || null;
}

export function getDeepSearchDefaultInstructions(): string {
  const config = getBesedyConfig();
  const instructions = config.web?.deep_search_default_instructions?.trim();
  if (!instructions) {
    throw new Error(
      "web.deep_search_default_instructions is required in besedy.toml."
    );
  }
  if (instructions.length > 4000) {
    throw new Error(
      "web.deep_search_default_instructions must be 4000 characters or fewer."
    );
  }
  return instructions;
}
