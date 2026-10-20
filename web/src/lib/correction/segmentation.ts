import { normalizeSpanText } from '@/lib/correction/text';

/**
 * Correction spans cut from the chunks a transcript was decoded in (ADR 0012).
 *
 * This is the port of `besedy/lib/correction_segmentation.py`, which documents
 * the rules. Both are checked against `contracts/correction-segmentation.json`;
 * change the three together and bump `SEGMENTATION_VERSION` when the output
 * changes. Sample offsets are integers, so every rule but word placement is
 * exact; word placement uses the same floating-point operations as Python.
 */
export const SEGMENTATION_VERSION = 'chunks-v1';

const SAMPLE_RATE = 16000;

export const SEGMENTATION_PARAMS = {
  sampleRate: SAMPLE_RATE,
  maxChunkSpeechSamples: 30 * SAMPLE_RATE,
  splitGapSamples: 1 * SAMPLE_RATE,
  maxSpanSamples: 30 * SAMPLE_RATE,
  mergeBelowSamples: 2 * SAMPLE_RATE,
} as const;

const {
  maxChunkSpeechSamples,
  splitGapSamples,
  maxSpanSamples,
  mergeBelowSamples,
} = SEGMENTATION_PARAMS;

export type SegmentationErrorCode = 'NO_REGIONS' | 'CHUNK_MISMATCH';

export class SegmentationError extends Error {
  constructor(
    readonly code: SegmentationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SegmentationError';
  }
}

/** One VAD region in samples of the staged 16 kHz audio. */
export interface Region {
  start: number;
  end: number;
}

export interface SegmentedSpan {
  chunk: number;
  firstRegion: number;
  lastRegion: number;
  startSample: number;
  endSample: number;
  regions: Region[];
  /** Indices into the chunk's segment words */
  wordIndices: number[];
  /** Those words, as the source stored them */
  words: Record<string, unknown>[];
  text: string;
}

export interface Segmentation {
  version: string;
  chunkCount: number;
  spans: SegmentedSpan[];
}

/** A machine word as the source stored it; only these three fields are read. */
type MachineWord = Record<string, unknown> & {
  word?: unknown;
  start?: unknown;
  end?: unknown;
};

/** Group region indices as `faster_whisper.vad.collect_chunks` does. */
export function buildChunks(regions: readonly Region[]): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let duration = 0;
  regions.forEach((region, index) => {
    const length = region.end - region.start;
    if (duration + length > maxChunkSpeechSamples) {
      chunks.push(current);
      current = [];
      duration = 0;
    }
    current.push(index);
    duration += length;
  });
  chunks.push(current);
  return chunks;
}

function windowOf(regions: readonly Region[], run: readonly number[]): number {
  return regions[run[run.length - 1]].end - regions[run[0]].start;
}

function gapBetween(
  regions: readonly Region[],
  left: number,
  right: number,
): number {
  return regions[right].start - regions[left].end;
}

/** Python tuple ordering for the numeric keys used below. */
function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function splitLong(regions: readonly Region[], run: number[]): number[][] {
  if (run.length === 1 || windowOf(regions, run) <= maxSpanSamples)
    return [run];
  let cut = 1;
  let best: number[] | null = null;
  for (let i = 1; i < run.length; i++) {
    const left = windowOf(regions, run.slice(0, i));
    const right = windowOf(regions, run.slice(i));
    const key = [
      left <= maxSpanSamples && right <= maxSpanSamples ? 1 : 0,
      gapBetween(regions, run[i - 1], run[i]),
      -Math.abs(left - right),
      -i,
    ];
    if (best === null || compareKeys(key, best) > 0) {
      cut = i;
      best = key;
    }
  }
  return [
    ...splitLong(regions, run.slice(0, cut)),
    ...splitLong(regions, run.slice(cut)),
  ];
}

function mergeShort(regions: readonly Region[], input: number[][]): number[][] {
  const runs = input.map((run) => [...run]);
  let changed = true;
  while (changed && runs.length > 1) {
    changed = false;
    for (let i = 0; i < runs.length && !changed; i++) {
      const run = runs[i];
      if (windowOf(regions, run) >= mergeBelowSamples) continue;
      // [gap, side, neighbour]; the previous neighbour wins ties
      const options: number[][] = [];
      if (i > 0)
        options.push([
          gapBetween(regions, runs[i - 1][runs[i - 1].length - 1], run[0]),
          0,
          i - 1,
        ]);
      if (i + 1 < runs.length)
        options.push([
          gapBetween(regions, run[run.length - 1], runs[i + 1][0]),
          1,
          i + 1,
        ]);
      options.sort(compareKeys);
      for (const [, , j] of options) {
        const low = Math.min(i, j);
        const merged = [...runs[low], ...runs[low + 1]];
        if (windowOf(regions, merged) <= maxSpanSamples) {
          runs.splice(low, 2, merged);
          changed = true;
          break;
        }
      }
    }
  }
  return runs;
}

/** Cut one chunk's region indices into correction runs. */
export function splitChunk(
  regions: readonly Region[],
  chunk: readonly number[],
): number[][] {
  if (chunk.length === 0) return [];
  const runs: number[][] = [];
  let current = [chunk[0]];
  for (let k = 1; k < chunk.length; k++) {
    if (gapBetween(regions, chunk[k - 1], chunk[k]) >= splitGapSamples) {
      runs.push(current);
      current = [];
    }
    current.push(chunk[k]);
  }
  runs.push(current);
  return mergeShort(
    regions,
    runs.flatMap((run) => splitLong(regions, run)),
  );
}

/** A word time: a finite JSON number, otherwise the fallback (as in Python). */
function toSeconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The chunk region holding the word's midpoint, else the nearest one. */
function regionOfWord(
  regions: readonly Region[],
  chunk: readonly number[],
  word: MachineWord,
): number {
  const start = toSeconds(word.start, 0) || 0;
  const end = toSeconds(word.end, start);
  const middle = (start + end) / 2;
  const seconds = chunk.map(
    (index) =>
      [
        regions[index].start / SAMPLE_RATE,
        regions[index].end / SAMPLE_RATE,
      ] as const,
  );
  return chunk[regionIndexForMidpoint(seconds, middle)];
}

/**
 * Index of the region (in seconds) holding a word's midpoint, else the nearest
 * one by distance, the earlier on a tie; -1 for no regions. The UI counts words
 * per region with the same rule, so each word lands in exactly one region.
 */
export function regionIndexForMidpoint(
  regions: ReadonlyArray<readonly [number, number]>,
  middle: number,
): number {
  let best = regions.length > 0 ? 0 : -1;
  let bestDistance: number | null = null;
  for (let index = 0; index < regions.length; index++) {
    const [lo, hi] = regions[index];
    if (lo <= middle && middle <= hi) return index;
    const distance = middle < lo ? lo - middle : middle - hi;
    if (bestDistance === null || distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Cut the segment text at the first word of each span; see the Python module. */
function spanTexts(
  text: string,
  words: readonly MachineWord[],
  owner: readonly number[],
  spanCount: number,
): string[] {
  const tokens = words.map((w) => normalizeSpanText(stringOf(w.word)));
  const fallback = Array.from({ length: spanCount }, (_, s) =>
    normalizeSpanText(tokens.filter((t, i) => owner[i] === s && t).join(' ')),
  );
  const starts = new Map<number, number>();
  let cursor = 0;
  let lastSpan = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const found = text.indexOf(token, cursor);
    if (found < 0 || owner[i] < lastSpan) return fallback;
    if (!starts.has(owner[i])) starts.set(owner[i], found);
    cursor = found + token.length;
    lastSpan = owner[i];
  }
  const texts = Array.from({ length: spanCount }, () => '');
  if (starts.size === 0) {
    if (spanCount > 0 && normalizeSpanText(text))
      texts[0] = normalizeSpanText(text);
    return texts;
  }
  const ordered = [...starts.keys()].sort((a, b) => a - b);
  ordered.forEach((span, k) => {
    const lo = k === 0 ? 0 : starts.get(span)!;
    const hi =
      k + 1 < ordered.length ? starts.get(ordered[k + 1])! : text.length;
    texts[span] = normalizeSpanText(text.slice(lo, hi));
  });
  return texts;
}

/** A JSON string; anything else is an empty string, as in Python. */
function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sampleOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new TypeError(String(value));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON object; anything else reads as empty, as in Python. */
function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function regionsOf(transcript: Record<string, unknown>): Region[] {
  const meta = recordOf(transcript.meta);
  const params = recordOf(meta.generation_params);
  const options = recordOf(params.transcription_options);
  const clips = options.clip_timestamps;
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new SegmentationError(
      'NO_REGIONS',
      'The source transcript records no VAD regions (clip_timestamps)',
    );
  }
  const regions = clips.map((clip) => {
    try {
      const { start, end } = clip as { start?: unknown; end?: unknown };
      return { start: sampleOf(start), end: sampleOf(end) };
    } catch {
      throw new SegmentationError(
        'NO_REGIONS',
        `Malformed clip_timestamps entry: ${JSON.stringify(clip)}`,
      );
    }
  });
  // Regions are read in audio order; two may touch but never overlap or go
  // backwards, and each holds some speech. Anything else is not VAD output,
  // and the chunk and span arithmetic would be meaningless on it.
  let previousEnd = 0;
  regions.forEach((region, index) => {
    if (region.start < previousEnd || region.end <= region.start) {
      throw new SegmentationError(
        'NO_REGIONS',
        'Malformed clip_timestamps: regions must be ordered and non-empty ' +
          `(region ${index} spans samples ${region.start}-${region.end})`,
      );
    }
    previousEnd = region.end;
  });
  return regions;
}

/** Correction spans for one canonical `transcript.json` document. */
export function segmentTranscript(transcript: unknown): Segmentation {
  const document = isRecord(transcript) ? transcript : {};
  const regions = regionsOf(document);
  const segments = Array.isArray(document.segments) ? document.segments : [];
  const chunks = buildChunks(regions);
  if (
    chunks.length !== segments.length ||
    chunks.some((chunk) => chunk.length === 0)
  ) {
    throw new SegmentationError(
      'CHUNK_MISMATCH',
      `The source has ${segments.length} segments but its VAD regions rebuild into ${chunks.length} chunks`,
    );
  }

  const spans: SegmentedSpan[] = [];
  chunks.forEach((chunk, chunkIndex) => {
    const segment = isRecord(segments[chunkIndex]) ? segments[chunkIndex] : {};
    const runs = splitChunk(regions, chunk);
    const runOfRegion = new Map<number, number>();
    runs.forEach((run, r) =>
      run.forEach((region) => runOfRegion.set(region, r)),
    );
    const words = (Array.isArray(segment.words) ? segment.words : []).filter(
      isRecord,
    ) as MachineWord[];
    const owner = words.map((w) =>
      runOfRegion.get(regionOfWord(regions, chunk, w))!,
    );
    const texts = spanTexts(stringOf(segment.text), words, owner, runs.length);
    runs.forEach((run, r) => {
      spans.push({
        chunk: chunkIndex,
        firstRegion: run[0],
        lastRegion: run[run.length - 1],
        startSample: regions[run[0]].start,
        endSample: regions[run[run.length - 1]].end,
        regions: run.map((i) => regions[i]),
        wordIndices: owner.flatMap((o, i) => (o === r ? [i] : [])),
        words: words.filter((_, i) => owner[i] === r),
        text: texts[r],
      });
    });
  });
  return { version: SEGMENTATION_VERSION, chunkCount: chunks.length, spans };
}
