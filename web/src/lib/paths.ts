import path from "path";
import { getBesedyConfig } from "./config";
import { TimestampIdSchema } from "./validation/schemas";

/**
 * Get transcripts base directory from config.
 * Returns: <text_data_dir>/transcripts/
 */
export function getTranscriptsBaseDir(): string {
  const config = getBesedyConfig();
  return path.join(config.paths.text_data_dir, "transcripts");
}

/**
 * Resolve transcripts directory for a group ID.
 * Returns: <transcripts_base_dir>/transcripts_<groupId>/
 */
export function resolveTranscriptsPath(groupId: string): string {
  const catalogId = TimestampIdSchema.parse(groupId);
  return path.join(getTranscriptsBaseDir(), `transcripts_${catalogId}`);
}
