/**
 * Generate all test fixtures
 *
 * Master script that generates all test data:
 * - Audio files (via ffmpeg)
 * - Catalog CSVs
 * - Transcript JSONs
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { generateAllAudio, checkFfmpeg } from "./generate-audio";
import { generateAllCatalogs } from "./generate-catalogs";
import { generateAllTranscripts } from "./generate-transcripts";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const fixturesDir = join(__dirname, "..", "fixtures");

  console.log("=== Generating E2E Test Fixtures ===\n");

  // Check dependencies
  if (!checkFfmpeg()) {
    console.error("ERROR: ffmpeg is required but not found.");
    console.error("Install with: sudo apt install ffmpeg");
    process.exit(1);
  }

  try {
    // Generate audio files
    console.log("\n[1/3] Audio Files");
    await generateAllAudio(fixturesDir);

    // Generate catalog CSVs
    console.log("\n[2/3] Catalog CSVs");
    await generateAllCatalogs(fixturesDir);

    // Generate transcripts
    console.log("\n[3/3] Transcripts");
    await generateAllTranscripts(fixturesDir);

    console.log("\n=== All fixtures generated successfully ===\n");
    console.log(`Location: ${fixturesDir}`);
  } catch (error) {
    console.error("\nFailed to generate fixtures:", error);
    process.exit(1);
  }
}

main();
