/**
 * Generate test catalog CSV files
 *
 * Creates CSV files matching the catalog schema for E2E testing.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { TEST_AUDIO_FILES } from "../../../prisma/test-data";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Format duration as HH:MM:SS
 */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Escape CSV field (handle commas and quotes)
 */
function escapeCSV(value: string | number | undefined): string {
  if (value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert array of objects to CSV string
 */
function toCSV(headers: string[], rows: Record<string, string | number | undefined>[]): string {
  const headerLine = headers.map(escapeCSV).join(",");
  const dataLines = rows.map((row) =>
    headers.map((h) => escapeCSV(row[h])).join(",")
  );
  return [headerLine, ...dataLines].join("\n") + "\n";
}

/**
 * Generate archived catalog CSV
 */
export async function generateArchivedCatalog(fixturesDir: string): Promise<string> {
  const headers = ["Hash", "Original Path", "Compressed Path", "Duration", "File Size"];

  const rows = TEST_AUDIO_FILES.map((file) => ({
    Hash: file.hash,
    "Original Path": `/data/audio/${file.filename}`,
    "Compressed Path": `/data/audio/compressed/${file.hash}.webm`,
    Duration: formatDuration(file.duration),
    "File Size": String(file.duration * 32000), // Approximate size for 16kHz mono
  }));

  const csv = toCSV(headers, rows);
  const outputPath = path.join(fixturesDir, "audio_catalog_test_archived.csv");
  await fs.writeFile(outputPath, csv);
  return outputPath;
}

/**
 * Generate metadata catalog CSV
 */
export async function generateMetadataCatalog(fixturesDir: string): Promise<string> {
  const headers = [
    "Hash",
    "Filename",
    "Size (bytes)",
    "Size (human)",
    "Full Path",
    "Status",
    "Duration",
    "album",
    "artist",
    "comment",
    "date",
    "encoded_by",
    "encoder",
    "genre",
    "title",
    "track",
    "sample_rate",
    "bit_depth",
    "channels",
    "bitrate_kbps",
    "codec_profile",
    "integrated_loudness_lufs",
    "true_peak_db",
    "loudness_range_lu",
    "input_thresh",
    "target_offset",
    "needs_normalization",
  ];

  const testMetadata = [
    { title: "Test Recording One", artist: "Recorder A", album: "Test Album", date: "2024", genre: "Speech" },
    { title: "Long Recording", artist: "Recorder B", album: "Test Album", date: "2024", genre: "Interview" },
    { title: "Short Clip", artist: "Recorder A", album: "Clips", date: "2023", genre: "Speech" },
    { title: "Extended Session", artist: "Recorder B", album: "Sessions", date: "2024", genre: "Discussion" },
    { title: "Quick Note", artist: "Recorder A", album: "Notes", date: "2024", genre: "Memo" },
  ];

  const rows = TEST_AUDIO_FILES.map((file, i) => ({
    Hash: file.hash,
    Filename: file.filename,
    "Size (bytes)": String(file.duration * 32000),
    "Size (human)": `${Math.round(file.duration * 32000 / 1024)} KB`,
    "Full Path": `/data/audio/${file.filename}`,
    Status: "Ready",
    Duration: formatDuration(file.duration),
    ...testMetadata[i],
    sample_rate: "16000",
    bit_depth: "16",
    channels: "1",
    bitrate_kbps: "256",
    codec_profile: "pcm_s16le",
    integrated_loudness_lufs: "-16.0",
    true_peak_db: "-1.0",
    loudness_range_lu: "5.0",
    input_thresh: "-26.0",
    target_offset: "0.0",
    needs_normalization: "No",
  }));

  const csv = toCSV(headers, rows);
  const outputPath = path.join(fixturesDir, "audio_catalog_test.csv");
  await fs.writeFile(outputPath, csv);
  return outputPath;
}

/**
 * Generate duplicates catalog CSV
 */
export async function generateDuplicatesCatalog(fixturesDir: string): Promise<string> {
  const headers = [
    "Hash",
    "Original Path",
    "Duplicate Path",
    "Size (bytes)",
    "Size (human)",
    "Duration",
    "album",
    "artist",
    "comment",
    "date",
    "encoded_by",
    "encoder",
    "genre",
    "title",
    "track",
  ];

  // Create 2 duplicates for the second test file
  const duplicateFile = TEST_AUDIO_FILES[1];
  const rows = [
    {
      Hash: duplicateFile.hash,
      "Original Path": `/data/audio/${duplicateFile.filename}`,
      "Duplicate Path": `/data/audio/backup/${duplicateFile.filename}`,
      "Size (bytes)": String(duplicateFile.duration * 32000),
      "Size (human)": `${Math.round(duplicateFile.duration * 32000 / 1024)} KB`,
      Duration: formatDuration(duplicateFile.duration),
      album: "Test Album",
      artist: "Recorder B",
      title: "Long Recording",
      date: "2024",
      genre: "Interview",
    },
    {
      Hash: duplicateFile.hash,
      "Original Path": `/data/audio/${duplicateFile.filename}`,
      "Duplicate Path": `/data/audio/archive/${duplicateFile.filename}`,
      "Size (bytes)": String(duplicateFile.duration * 32000),
      "Size (human)": `${Math.round(duplicateFile.duration * 32000 / 1024)} KB`,
      Duration: formatDuration(duplicateFile.duration),
      album: "Test Album",
      artist: "Recorder B",
      title: "Long Recording",
      date: "2024",
      genre: "Interview",
    },
  ];

  const csv = toCSV(headers, rows);
  const outputPath = path.join(fixturesDir, "audio_catalog_test_duplicates.csv");
  await fs.writeFile(outputPath, csv);
  return outputPath;
}

/**
 * Generate all catalog files
 */
export async function generateAllCatalogs(fixturesDir: string): Promise<void> {
  await fs.mkdir(fixturesDir, { recursive: true });

  console.log("Generating test catalog CSVs...");

  const archived = await generateArchivedCatalog(fixturesDir);
  console.log(`  Generated: ${path.basename(archived)}`);

  const metadata = await generateMetadataCatalog(fixturesDir);
  console.log(`  Generated: ${path.basename(metadata)}`);

  const duplicates = await generateDuplicatesCatalog(fixturesDir);
  console.log(`  Generated: ${path.basename(duplicates)}`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturesDir = path.join(__dirname, "..", "fixtures");
  generateAllCatalogs(fixturesDir).catch(console.error);
}
