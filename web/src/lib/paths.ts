import path from "path";
import { getBesedyConfig } from "./config";

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
 * Resolve transcripts directory for a group ID.
 * Returns: <transcripts_base_dir>/transcripts_<groupId>/
 */
export function resolveTranscriptsPath(groupId: string): string {
  return path.join(getTranscriptsBaseDir(), `transcripts_${groupId}`);
}
