/**
 * Generate test transcript files
 *
 * Creates transcript JSON files matching the transcript schema for E2E testing.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import {
  TEST_AUDIO_FILES,
  TEST_TRANSCRIPTS_COMPLETE_MARKER,
  TEST_TRANSCRIPTS_SUBDIR,
} from "../../../prisma/test-data";

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

/** The recording whose faster-whisper transcript has the batched shape correction needs. */
export const CORRECTION_RECORDING = "ab00004dab";
const SAMPLE_RATE = 16000;

/**
 * A faster-whisper transcript in the shape the production pipeline writes
 * (batched decoding, ADR 0012): VAD regions in clip_timestamps, packed into
 * chunks of at most 30 s of speech, one segment per chunk, words with times.
 *
 * The chunks cover what the correction page has to show: a run split at a
 * pause, speech the model wrote nothing for, a short run merged into its
 * neighbour, and a chunk with no text at all.
 */
function batchedTranscript(hash: string, duration: number) {
  const chunks: { regions: [number, number][]; words: [string, number, number][]; text: string }[] = [
    {
      // Two runs split by a 1.2 s pause.
      regions: [[0.2, 9.0], [10.2, 18.6], [19.2, 27.4]],
      words: [["Dobrý", 0.4, 0.9], ["den,", 0.9, 1.4], ["vítejte.", 1.5, 2.6], ["Dnes", 10.4, 10.9], ["budeme", 10.9, 11.5], ["mluvit.", 11.5, 12.4]],
      text: "Dobrý den, vítejte. Dnes budeme mluvit.",
    },
    {
      // The last run has speech but no words: what the model dropped.
      regions: [[30.0, 39.5], [40.8, 48.0], [49.4, 57.6]],
      words: [["Pojďme", 30.3, 30.9], ["na", 30.9, 31.1], ["první", 31.1, 31.6], ["téma.", 31.6, 32.4], ["Je", 41.0, 41.3], ["zajímavé.", 41.3, 42.4]],
      text: "Pojďme na první téma. Je zajímavé.",
    },
    {
      // A 0.8 s run after a 1.1 s pause joins its neighbour.
      regions: [[60.0, 74.0], [75.1, 75.9], [77.4, 88.0]],
      words: [["Samozřejmě,", 60.4, 61.3], ["vysvětlím", 61.3, 62.1], ["to.", 62.1, 62.6], ["Ano.", 75.2, 75.7], ["Děkuji.", 77.8, 78.6]],
      text: "Samozřejmě, vysvětlím to. Ano. Děkuji.",
    },
    {
      // Nothing written for the whole chunk.
      regions: [[90.0, 100.0], [101.5, 117.0]],
      words: [],
      text: "",
    },
  ];
  return {
    meta: {
      backend: "faster-whisper",
      model: "large-v3",
      audio_filepath: `/data/audio/audio_staged/${hash}.wav`,
      duration,
      generation_params: {
        batch_size: 8,
        vad_filter: true,
        word_timestamps: true,
        transcription_options: {
          without_timestamps: true,
          clip_timestamps: chunks.flatMap((chunk) =>
            chunk.regions.map(([start, end]) => ({
              start: Math.round(start * SAMPLE_RATE),
              end: Math.round(end * SAMPLE_RATE),
            }))
          ),
        },
      },
    },
    segments: chunks.map((chunk, id) => ({
      id,
      start: chunk.words[0]?.[1] ?? chunk.regions[0][0],
      end: chunk.words.at(-1)?.[2] ?? chunk.regions.at(-1)![1],
      text: chunk.text,
      words: chunk.words.map(([word, start, end]) => ({ word, start, end, confidence: 0.9 })),
    })),
  };
}

/**
 * Generate ASR transcript file
 */
async function generateASRTranscript(
  transcriptsDir: string,
  hash: string,
  duration: number,
  backend: string = "faster-whisper",
  model: string = "large-v3@silero_vad_v6@lang-cs"
): Promise<void> {
  const outputDir = path.join(transcriptsDir, backend, model, hash);
  await fs.mkdir(outputDir, { recursive: true });

  const transcript =
    backend === "faster-whisper" && hash.startsWith(CORRECTION_RECORDING)
      ? batchedTranscript(hash, duration)
      : {
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
  { backend: "faster-whisper", model: "large-v3@silero_vad_v6@lang-cs" },
  { backend: "canary-nemo", model: "canary-1b@lang-cs" },
];

/**
 * Generate all transcript files
 */
export async function generateAllTranscripts(fixturesDir: string): Promise<void> {
  const transcriptsDir = path.join(fixturesDir, TEST_TRANSCRIPTS_SUBDIR);
  const completeMarker = path.join(fixturesDir, TEST_TRANSCRIPTS_COMPLETE_MARKER);

  // The marker goes first: if anything below fails, the next run regenerates.
  await fs.rm(completeMarker, { force: true });

  // Earlier checkouts have a local symlink `transcripts -> transcripts_test`.
  // Remove the link itself first: removing `transcriptsDir` below would follow
  // it, and `mkdir` would then fail on the dangling link with ENOTDIR.
  const transcriptsRoot = path.join(fixturesDir, path.dirname(TEST_TRANSCRIPTS_SUBDIR));
  const rootStat = await fs.lstat(transcriptsRoot).catch(() => null);
  if (rootStat?.isSymbolicLink()) {
    await fs.unlink(transcriptsRoot);
  }

  // Start clean so hashes or backends no longer generated don't linger.
  // Earlier versions wrote to transcripts_test, where the web app never looked.
  await fs.rm(transcriptsDir, { recursive: true, force: true });
  await fs.rm(path.join(fixturesDir, "transcripts_test"), { recursive: true, force: true });
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

  await fs.writeFile(completeMarker, "");
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturesDir = path.join(__dirname, "..", "fixtures");
  generateAllTranscripts(fixturesDir).catch(console.error);
}
