import path from "path";
import { getTextDataDir, getBesedyConfig } from "./config";

/**
 * Get catalogs directory from config.
 * Returns: <text_data_dir>/catalogs/
 */
export function getCatalogsDir(): string {
  return path.join(getTextDataDir(), "catalogs");
}

/**
 * Get transcripts base directory from config.
 * Returns: <text_data_dir>/<transcripts_dir>/
 */
export function getTranscriptsBaseDir(): string {
  const config = getBesedyConfig();
  const transcriptsDir = config.paths.transcripts_dir || "transcripts";
  return path.join(config.paths.text_data_dir, transcriptsDir);
}

/**
 * Resolve archived catalog path for a group ID.
 * Returns: <catalogs_dir>/audio_catalog_<groupId>_loudness_archived.csv
 */
export function resolveArchivedCatalogPath(groupId: string): string {
  return path.join(
    getCatalogsDir(),
    `audio_catalog_${groupId}_loudness_archived.csv`
  );
}

/**
 * Resolve metadata catalog path for a group ID.
 * Returns: <catalogs_dir>/audio_catalog_<groupId>.csv
 */
export function resolveMetadataCatalogPath(groupId: string): string {
  return path.join(getCatalogsDir(), `audio_catalog_${groupId}.csv`);
}

/**
 * Resolve transcripts directory for a group ID.
 * Returns: <transcripts_base_dir>/transcripts_<groupId>/
 */
export function resolveTranscriptsPath(groupId: string): string {
  return path.join(getTranscriptsBaseDir(), `transcripts_${groupId}`);
}

/**
 * Resolve duplicates catalog path for a group ID.
 * Returns: <catalogs_dir>/audio_catalog_<groupId>_duplicates.csv
 */
export function resolveDuplicatesCatalogPath(groupId: string): string {
  return path.join(getCatalogsDir(), `audio_catalog_${groupId}_duplicates.csv`);
}
