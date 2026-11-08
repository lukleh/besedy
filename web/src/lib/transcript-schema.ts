import { z } from 'zod';

// Runtime mirror of docs/schemas/transcript.schema.json. The web image is built
// from web/ alone; transcript-disk-contract.test.ts checks both contracts.
const confidenceSchema = z.number().min(0).max(1).nullable();

const wordSchema = z.looseObject({
  start: z.number(),
  end: z.number(),
  word: z.string(),
  confidence: confidenceSchema,
});

const segmentSchema = z.looseObject({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  confidence: confidenceSchema,
  words: z.array(wordSchema),
});

const metaSchema = z.looseObject({
  model: z.string(),
  backend: z.enum([
    'canary-nemo',
    'canary-nemo-beam',
    'faster-whisper',
    'whisperx',
    'qwen3-asr',
  ]),
  audio_filepath: z.string(),
  duration: z.number().min(0),
  generation_params: z.looseObject({}),
  num_segments: z.number().int().min(0).optional(),
  num_words: z.number().int().min(0).optional(),
  transcript_text: z.string().optional(),
});

export const canonicalTranscriptSchema = z.looseObject({
  meta: metaSchema,
  segments: z.array(segmentSchema),
  vad_segments: z
    .array(z.looseObject({ start: z.number(), end: z.number() }))
    .optional(),
});

export type CanonicalTranscript = z.infer<typeof canonicalTranscriptSchema>;

/** Each current backend records its output language in its generation options. */
export function canonicalTranscriptLanguage(
  data: CanonicalTranscript,
): string | undefined {
  const field =
    data.meta.backend === 'canary-nemo' ||
    data.meta.backend === 'canary-nemo-beam'
      ? 'target_lang'
      : 'language';
  const language = data.meta.generation_params[field];
  return typeof language === 'string' ? language : undefined;
}
