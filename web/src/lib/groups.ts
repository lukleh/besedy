import fs from "fs/promises";
import {
  getCatalogsDir,
  getTranscriptsBaseDir,
  resolveArchivedCatalogPath,
  resolveMetadataCatalogPath,
  resolveTranscriptsPath,
} from "./paths";

/**
 * Pattern to extract timestamp from catalog files
 * e.g. audio_catalog_20251201_143022.csv -> 20251201_143022
 */
const CATALOG_FILE_PATTERN = /^audio_catalog_(\d{8}_\d{6})\.csv$/;

/**
 * A discovered workflow group from the filesystem
 */
export interface DiscoveredGroup {
  id: string; // Timestamp ID e.g. "20251201_143022"
  label?: string;
  archivedCatalogPath: string;
  metadataCatalogPath: string;
  transcriptsPath?: string;
}

/**
 * Scan the configured directories for workflow groups by looking for
 * timestamp patterns in audio catalog filenames.
 *
 * Uses paths from besedy.toml config:
 * - Catalogs: <text_data_dir>/catalogs/
 * - Transcripts: <text_data_dir>/<transcripts_dir>/
 *
 * Discovery rules:
 * 1. Look for files matching audio_catalog_<timestamp>.csv (metadata source)
 * 2. Check for corresponding audio_catalog_<timestamp>_loudness_archived.csv
 * 3. Check for transcripts_<timestamp>/ directory
 */
export async function discoverGroups(): Promise<DiscoveredGroup[]> {
  const groups: DiscoveredGroup[] = [];
  const catalogsDir = getCatalogsDir();
  const transcriptsBaseDir = getTranscriptsBaseDir();

  try {
    const entries = await fs.readdir(catalogsDir, { withFileTypes: true });

    // Find all metadata catalog files
    const metadataCatalogs = entries
      .filter(
        (entry) => entry.isFile() && CATALOG_FILE_PATTERN.test(entry.name)
      )
      .map((entry) => {
        const match = entry.name.match(CATALOG_FILE_PATTERN);
        return {
          filename: entry.name,
          timestamp: match![1],
        };
      });

    // Process each discovered timestamp
    for (const catalog of metadataCatalogs) {
      const { timestamp } = catalog;

      // Check for archived catalog
      const archivedPath = resolveArchivedCatalogPath(timestamp);
      const hasArchived = await fileExists(archivedPath);

      // Only include groups that have both metadata and archived catalogs
      if (!hasArchived) {
        continue;
      }

      // Check for transcripts directory
      const transcriptsPath = resolveTranscriptsPath(timestamp);
      const hasTranscripts = await directoryExists(transcriptsPath);

      groups.push({
        id: timestamp,
        archivedCatalogPath: archivedPath,
        metadataCatalogPath: resolveMetadataCatalogPath(timestamp),
        transcriptsPath: hasTranscripts ? transcriptsPath : undefined,
      });
    }

    // Sort by timestamp descending (most recent first)
    groups.sort((a, b) => b.id.localeCompare(a.id));
  } catch (error) {
    console.error("Error discovering workflow groups:", error);
    console.error("Catalogs dir:", catalogsDir);
    console.error("Transcripts base dir:", transcriptsBaseDir);
  }

  return groups;
}

/**
 * Format a timestamp ID as a human-readable label
 * e.g. "20251201_143022" -> "Dec 1, 2025 14:30"
 */
export function formatTimestampLabel(id: string): string {
  const match = id.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!match) return id;

  const [, year, month, day, hour, minute] = match;
  const date = new Date(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hour),
    parseInt(minute)
  );

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
