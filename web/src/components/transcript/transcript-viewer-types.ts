"use client";

import { z } from "zod";

export type TranscriptBackend = string;
export type TranscriptFormat = "json" | "txt" | "srt" | "vtt";
export type DiarizationBackend = "pyannote";

export interface AvailableFormats {
  hash: string;
  backend: TranscriptBackend;
  formats: TranscriptFormat[];
  canDownload: boolean;
}

export interface SpeakerSegment {
  start: number;
  end: number;
  speaker: string;
}

export interface Diarization {
  hash: string;
  model: string;
  numSpeakers: number;
  segments: SpeakerSegment[];
}

export interface AvailableDiarizations {
  hash: string;
  backends: DiarizationBackend[];
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
  speaker?: string;
  words?: TranscriptWord[];
}

export interface Transcript {
  backend: TranscriptBackend;
  segments: TranscriptSegment[];
}

export interface AvailableTranscripts {
  hash: string;
  backends: TranscriptBackend[];
}

export const availableFormatsSchema = z.object({
  hash: z.string(),
  backend: z.string(),
  formats: z.array(z.enum(["json", "txt", "srt", "vtt"])),
  canDownload: z.boolean(),
});

export const speakerSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  speaker: z.string(),
});

export const diarizationSchema = z.object({
  hash: z.string(),
  model: z.string(),
  numSpeakers: z.number(),
  segments: z.array(speakerSegmentSchema),
});

export const availableDiarizationsSchema = z.object({
  hash: z.string(),
  backends: z.array(z.literal("pyannote")),
});

export const transcriptWordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional(),
});

export const transcriptSegmentSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  speaker: z.string().optional(),
  words: z.array(transcriptWordSchema).optional(),
});

export const transcriptSchema = z.object({
  backend: z.string(),
  segments: z.array(transcriptSegmentSchema),
});

export const availableTranscriptsSchema = z.object({
  hash: z.string(),
  backends: z.array(z.string()),
});

export interface TranscriptViewerProps {
  hash: string;
  groupId?: string;
  currentTime?: number;
  onSeek?: (time: number) => void;
  isPlaying?: boolean;
  canDownload?: boolean;
}

export interface TranscriptContentProps {
  transcript: Transcript;
  currentTime: number;
  onSeek?: (time: number) => void;
  autoScroll?: boolean;
  diarization?: Diarization;
  showTimestamps?: boolean;
  scrollToTime?: number | null;
  onScrollComplete?: () => void;
}

export const AUTO_SCROLL_PREF_KEY = "besedy-transcript-autoscroll";
export const SPEAKER_LABELS_PREF_KEY = "besedy-speaker-labels";
export const TIMESTAMPS_PREF_KEY = "besedy-timestamps";
export const VIRTUAL_SCROLL_THRESHOLD = 100;

const SPEAKER_COLORS = [
  "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
  "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
];

export function getSpeakerColor(speakerId: string, speakerMap: Map<string, number>): string {
  if (!speakerMap.has(speakerId)) {
    speakerMap.set(speakerId, speakerMap.size);
  }
  const idx = speakerMap.get(speakerId) ?? 0;
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length];
}

export function findSpeakerAtTime(time: number, segments: SpeakerSegment[]): string | null {
  for (const seg of segments) {
    if (time >= seg.start && time < seg.end) {
      return seg.speaker;
    }
  }
  return null;
}
