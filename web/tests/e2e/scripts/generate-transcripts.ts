/**
 * Generate test transcript files
 *
 * Creates transcript JSON files matching the transcript schema for E2E testing.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { TEST_AUDIO_FILES } from "../../../prisma/test-data";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sample Czech text for transcripts
const SAMPLE_SENTENCES = [
  "Dobrý den, vítejte u dnešního rozhovoru.",
  "Dnes budeme diskutovat o zajímavých tématech.",
  "Děkuji za vaši účast v této nahrávce.",
  "Pojďme se podívat na první téma.",
  "To je velmi zajímavý pohled na věc.",
  "Můžete nám říct více o vašich zkušenostech?",
  "Samozřejmě, rád vám to vysvětlím.",
  "Historie tohoto projektu sahá daleko do minulosti.",
  "Myslím, že to je klíčový bod diskuse.",
  "Děkuji za vaši pozornost a nashledanou.",
];

/**
 * Generate random segments for an ASR transcript
 */
function generateSegments(
  duration: number,
  segmentLength: number = 5
): { text: string; start: number; end: number; words?: { word: string; start: number; end: number; confidence: number }[] }[] {
  const segments = [];
  let currentTime = 0;
  let sentenceIndex = 0;

  while (currentTime < duration) {
    const segmentDuration = Math.min(segmentLength, duration - currentTime);
    const text = SAMPLE_SENTENCES[sentenceIndex % SAMPLE_SENTENCES.length];

    // Generate word-level timestamps
    const words = text.split(" ").map((word, i, arr) => {
      const wordDuration = segmentDuration / arr.length;
      return {
        word,
        start: currentTime + i * wordDuration,
        end: currentTime + (i + 1) * wordDuration,
        confidence: 0.85 + Math.random() * 0.15,
      };
    });

    segments.push({
      id: segments.length,
      text,
      start: currentTime,
      end: currentTime + segmentDuration,
      words,
    });

    currentTime += segmentDuration;
    sentenceIndex++;
  }

  return segments;
}

/**
 * Generate speaker diarization
 */
function generateDiarization(duration: number): {
  start: number;
  end: number;
  speaker: string;
}[] {
  const segments = [];
  let currentTime = 0;
  let speakerIndex = 0;
  const segmentLength = 15;

  while (currentTime < duration) {
    const segDuration = Math.min(segmentLength, duration - currentTime);
    segments.push({
      start: currentTime,
      end: currentTime + segDuration,
      speaker: `SPEAKER_${String(speakerIndex % 2).padStart(2, "0")}`,
    });

    currentTime += segDuration;
    speakerIndex++;
  }

  return segments;
}

/**
 * Generate ASR transcript file
 */
async function generateASRTranscript(
  transcriptsDir: string,
  hash: string,
  duration: number,
  backend: string = "faster-whisper",
  model: string = "large-v3@silero_vad_v6"
): Promise<void> {
  const outputDir = path.join(transcriptsDir, backend, model, hash);
  await fs.mkdir(outputDir, { recursive: true });

  const transcript = {
    backend,
    hash,
    model,
    language: "cs",
    duration,
    segments: generateSegments(duration),
  };

  await fs.writeFile(
    path.join(outputDir, "transcript.json"),
    JSON.stringify(transcript, null, 2)
  );

  // Generate sidecar files
  const textContent = transcript.segments.map((s) => s.text).join(" ");
  await fs.writeFile(path.join(outputDir, "transcript.txt"), textContent);

  // Generate SRT
  const srtContent = transcript.segments
    .map((s, i) => {
      const formatTime = (t: number) => {
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const sec = Math.floor(t % 60);
        const ms = Math.floor((t % 1) * 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
      };
      return `${i + 1}\n${formatTime(s.start)} --> ${formatTime(s.end)}\n${s.text}\n`;
    })
    .join("\n");
  await fs.writeFile(path.join(outputDir, "transcript.srt"), srtContent);

  // Generate VTT
  const vttContent = "WEBVTT\n\n" + transcript.segments
    .map((s) => {
      const formatTime = (t: number) => {
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const sec = Math.floor(t % 60);
        const ms = Math.floor((t % 1) * 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
      };
      return `${formatTime(s.start)} --> ${formatTime(s.end)}\n${s.text}\n`;
    })
    .join("\n");
  await fs.writeFile(path.join(outputDir, "transcript.vtt"), vttContent);
}

/**
 * Generate diarization file
 */
async function generateDiarizationFile(
  transcriptsDir: string,
  hash: string,
  duration: number
): Promise<void> {
  const outputDir = path.join(transcriptsDir, "speaker_diarization", "pyannote_3.1", hash);
  await fs.mkdir(outputDir, { recursive: true });

  const diarization = {
    hash,
    model: "pyannote_3.1",
    num_speakers: 2,
    segments: generateDiarization(duration),
  };

  await fs.writeFile(
    path.join(outputDir, "speakers.json"),
    JSON.stringify(diarization, null, 2)
  );
}

// Backends to generate transcripts for
const TRANSCRIPT_BACKENDS = [
  { backend: "faster-whisper", model: "large-v3@silero_vad_v6" },
  { backend: "canary-nemo", model: "canary-1b" },
];

/**
 * Generate all transcript files
 */
export async function generateAllTranscripts(fixturesDir: string): Promise<void> {
  const transcriptsDir = path.join(fixturesDir, "transcripts_test");

  await fs.mkdir(transcriptsDir, { recursive: true });

  console.log("Generating test transcripts...");

  for (const file of TEST_AUDIO_FILES) {
    const hash = file.hash;

    // Generate ASR transcripts for all backends
    for (const { backend, model } of TRANSCRIPT_BACKENDS) {
      await generateASRTranscript(transcriptsDir, hash, file.duration, backend, model);
      console.log(`  Generated: ${backend} transcript for ${file.filename}`);
    }

    // Generate diarization
    await generateDiarizationFile(transcriptsDir, hash, file.duration);
    console.log(`  Generated: Diarization for ${file.filename}`);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturesDir = path.join(__dirname, "..", "fixtures");
  generateAllTranscripts(fixturesDir).catch(console.error);
}
