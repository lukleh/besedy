/**
 * Generate test audio files using ffmpeg
 *
 * Creates synthetic audio files (sine waves) for E2E testing.
 * These files are gitignored and regenerated on each test run.
 */

import { execFileSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { TEST_AUDIO_FILES } from "../../../prisma/test-data";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TestAudioFile {
  hash: string;
  filename: string;
  duration: number; // seconds
  frequency: number; // Hz
}

/**
 * Check if ffmpeg is available
 */
export function checkFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a single test audio file
 */
export async function generateAudioFile(
  outputDir: string,
  spec: TestAudioFile
): Promise<string> {
  const outputPath = path.join(outputDir, spec.filename);

  // Generate sine wave audio using ffmpeg
  // -f lavfi: use libavfilter input
  // sine: generate sine wave
  // -ar 16000: sample rate 16kHz (matches production requirement)
  // -ac 1: mono channel
  const args = [
    "-y", // overwrite output
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${spec.frequency}:duration=${spec.duration}`,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le", // 16-bit PCM
    outputPath,
  ];

  execFileSync("ffmpeg", args, { stdio: "ignore" });

  return outputPath;
}

/**
 * Generate compressed WebM version (for streaming)
 */
export async function generateCompressedAudio(
  wavPath: string,
  outputDir: string,
  hash: string
): Promise<string> {
  const compressedDir = path.join(outputDir, "compressed");
  await fs.mkdir(compressedDir, { recursive: true });

  const outputPath = path.join(compressedDir, `${hash}.webm`);

  const args = [
    "-y",
    "-i",
    wavPath,
    "-c:a",
    "libopus",
    "-b:a",
    "64k",
    outputPath,
  ];

  execFileSync("ffmpeg", args, { stdio: "ignore" });

  return outputPath;
}

/**
 * Generate all test audio files
 */
export async function generateAllAudio(fixturesDir: string): Promise<void> {
  const audioDir = path.join(fixturesDir, "audio");
  await fs.mkdir(audioDir, { recursive: true });

  if (!checkFfmpeg()) {
    throw new Error("ffmpeg is required but not found. Install it with: sudo apt install ffmpeg");
  }

  console.log("Generating test audio files...");

  for (const spec of TEST_AUDIO_FILES) {
    const wavPath = await generateAudioFile(audioDir, spec);
    await generateCompressedAudio(wavPath, audioDir, spec.hash);
    console.log(`  Generated: ${spec.filename} (${spec.duration}s @ ${spec.frequency}Hz)`);
  }

  console.log(`Generated ${TEST_AUDIO_FILES.length} audio files in ${audioDir}`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturesDir = path.join(__dirname, "..", "fixtures");
  generateAllAudio(fixturesDir).catch(console.error);
}
