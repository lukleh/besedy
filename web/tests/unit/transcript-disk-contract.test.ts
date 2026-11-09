import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  discoverTranscriptBackends,
  getAvailableTranscripts,
  loadTranscript,
  readTranscriptFile,
} from '@/lib/transcript';
import { canonicalTranscriptSchema } from '@/lib/transcript-schema';
import { readMachineSource } from '@/lib/correction/source';
import { loadPublishedTranscript } from '@/lib/correction/reader-transcript';
import { readJsonFile } from '@/lib/correction/storage';
import { transcriptSchema } from '@/components/transcript/transcript-viewer-types';

vi.mock('@/lib/security/path-validation', () => ({
  validatePath: (value: string) => ({ valid: true, resolvedPath: value }),
}));
vi.mock('@/lib/transcript-priority', () => ({
  listTranscriptBackendPriorities: vi.fn(),
}));
vi.mock('@/lib/correction/storage', () => ({
  readJsonFile: vi.fn(),
  readTextFile: vi.fn(),
}));
vi.mock('@/lib/correction/resolve', () => ({
  publicationArtifactPath: () => '/publication/transcript.json',
}));
vi.mock('@/lib/correction/workspace-service', () => ({
  computeProgress: vi.fn(),
}));

const HASH = 'a'.repeat(64);
const BACKEND = 'faster-whisper/large-v3@silero_vad_v6@lang-cs';
const publication = {
  kind: 'publication',
  workspaceId: 'workspace',
  publicationId: 'publication',
} as const;

function currentTranscript() {
  return {
    meta: {
      backend: 'faster-whisper',
      model: 'large-v3',
      audio_filepath: '/audio/staged.wav',
      duration: 12,
      generation_params: { language: 'cs' },
    },
    segments: [
      {
        start: 0,
        end: 1,
        text: 'Dobrý den',
        confidence: null,
        words: [{ start: 0, end: 1, word: 'Dobrý den', confidence: null }],
      },
    ],
  };
}

describe('current transcript disk contract', () => {
  let root: string;
  let file: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(path.join(os.tmpdir(), 'besedy-transcript-contract-'));
    file = path.join(root, BACKEND, HASH, 'transcript.json');
    await mkdir(path.dirname(file), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function store(data: unknown) {
    await writeFile(file, JSON.stringify(data));
    vi.mocked(readJsonFile).mockResolvedValue(data);
  }

  it('reads canonical metadata without requiring an audio_hash field and preserves null confidence', async () => {
    const data = currentTranscript();
    await store({ ...data, language: 'en', duration: 999 });
    const transcript = await loadTranscript(root, HASH, BACKEND);
    expect(transcript).toMatchObject({
      backend: BACKEND,
      hash: HASH,
      model: 'large-v3',
      language: 'cs',
      duration: 12,
      segments: data.segments,
    });
    expect(transcriptSchema.parse(transcript).segments[0]).toMatchObject({
      confidence: null,
      words: [{ confidence: null }],
    });
    expect((await readMachineSource(root, HASH, BACKEND)).content).toBe(
      await readFile(file, 'utf8'),
    );
    expect(
      await loadPublishedTranscript('catalog', HASH, publication),
    ).toMatchObject({
      model: 'large-v3',
      language: 'cs',
      duration: 12,
      segments: [{ start: 0, end: 1, text: 'Dobrý den', words: [] }],
    });
  });

  it.each([
    {
      backend: 'canary-nemo',
      generationParams: { source_lang: 'sk', target_lang: 'sk' },
      expectedLanguage: 'sk',
    },
    {
      // Beam output passes through the WhisperX canonical converter.
      backend: 'canary-nemo-beam',
      generationParams: { language: 'cs' },
      expectedLanguage: 'cs',
    },
    {
      backend: 'faster-whisper',
      generationParams: { language: 'cs' },
      expectedLanguage: 'cs',
    },
    {
      backend: 'whisperx',
      generationParams: { language: 'cs' },
      expectedLanguage: 'cs',
    },
    {
      backend: 'qwen3-asr',
      generationParams: { language: 'cs', requested_language: 'cs' },
      expectedLanguage: 'cs',
    },
  ])(
    'reads the current $backend language in machine and published transcripts',
    async ({ backend, generationParams, expectedLanguage }) => {
      const data = {
        ...currentTranscript(),
        meta: {
          ...currentTranscript().meta,
          backend,
          generation_params: generationParams,
        },
      };
      const backendKey = `${backend}/model@lang-${expectedLanguage}`;
      const backendFile = path.join(root, backendKey, HASH, 'transcript.json');
      await mkdir(path.dirname(backendFile), { recursive: true });
      await writeFile(backendFile, JSON.stringify(data));
      vi.mocked(readJsonFile).mockResolvedValue(data);

      expect((await loadTranscript(root, HASH, backendKey))?.language).toBe(
        expectedLanguage,
      );
      expect(
        (await loadPublishedTranscript('catalog', HASH, publication))?.language,
      ).toBe(expectedLanguage);
    },
  );

  it('leaves unknown output language absent instead of reading obsolete flat fields', async () => {
    await store({
      ...currentTranscript(),
      language: 'en',
      meta: {
        ...currentTranscript().meta,
        language: 'de',
        generation_params: {},
      },
    });
    expect(
      (await loadTranscript(root, HASH, BACKEND))?.language,
    ).toBeUndefined();
    expect(
      (await loadPublishedTranscript('catalog', HASH, publication))?.language,
    ).toBeUndefined();
  });

  it('preserves allowed extra fields without treating generation options as typed metadata', () => {
    const data = {
      ...currentTranscript(),
      extra: { retained: true },
      meta: {
        ...currentTranscript().meta,
        extra: 'retained',
        generation_params: { language: null, nested: { option: true } },
      },
      segments: [
        {
          ...currentTranscript().segments[0],
          speaker: 'SPEAKER_01',
          words: [{ ...currentTranscript().segments[0].words[0], extra: true }],
        },
      ],
    };
    expect(canonicalTranscriptSchema.parse(data)).toEqual(data);
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite numbers (%s)',
    (value) => {
      for (const data of [
        {
          ...currentTranscript(),
          meta: { ...currentTranscript().meta, duration: value },
        },
        {
          ...currentTranscript(),
          segments: [{ ...currentTranscript().segments[0], start: value }],
        },
        {
          ...currentTranscript(),
          segments: [{ ...currentTranscript().segments[0], confidence: value }],
        },
        {
          ...currentTranscript(),
          segments: [
            {
              ...currentTranscript().segments[0],
              words: [
                { ...currentTranscript().segments[0].words[0], end: value },
              ],
            },
          ],
        },
        {
          ...currentTranscript(),
          segments: [
            {
              ...currentTranscript().segments[0],
              words: [
                {
                  ...currentTranscript().segments[0].words[0],
                  confidence: value,
                },
              ],
            },
          ],
        },
      ]) {
        expect(canonicalTranscriptSchema.safeParse(data).success).toBe(false);
      }
    },
  );

  it('ignores old unsuffixed trees and keeps publications out of machine disk access', async () => {
    for (const backend of ['faster-whisper/large-v3', 'corrected/published']) {
      const target = path.join(root, backend, HASH, 'transcript.json');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(currentTranscript()));
      expect(await loadTranscript(root, HASH, backend)).toBeNull();
      expect(await readTranscriptFile(root, HASH, backend, 'json')).toBeNull();
      await expect(
        readMachineSource(root, HASH, backend),
      ).rejects.toMatchObject({ code: 'SOURCE_MISSING' });
    }
    await store(currentTranscript());
    expect(await discoverTranscriptBackends([root])).toEqual([BACKEND]);
    expect((await getAvailableTranscripts(root, HASH)).backends).toEqual([
      BACKEND,
    ]);
  });

  const invalid = [
    [
      'flat legacy transcript',
      { language: 'cs', duration: 12, segments: currentTranscript().segments },
    ],
    ['missing segments', { meta: currentTranscript().meta }],
    ['nonarray segments', { ...currentTranscript(), segments: {} }],
    ['empty metadata', { ...currentTranscript(), meta: {} }],
    [
      'unknown backend alias',
      {
        ...currentTranscript(),
        meta: { ...currentTranscript().meta, backend: 'nemo' },
      },
    ],
    [
      'missing segment words',
      {
        ...currentTranscript(),
        segments: [{ start: 0, end: 1, text: 'text', confidence: null }],
      },
    ],
    [
      'missing segment confidence',
      {
        ...currentTranscript(),
        segments: [{ start: 0, end: 1, text: 'text', words: [] }],
      },
    ],
    [
      'missing word confidence',
      {
        ...currentTranscript(),
        segments: [
          {
            ...currentTranscript().segments[0],
            words: [{ start: 0, end: 1, word: 'text' }],
          },
        ],
      },
    ],
    [
      'out-of-range confidence',
      {
        ...currentTranscript(),
        segments: [{ ...currentTranscript().segments[0], confidence: 2 }],
      },
    ],
    [
      'string timing',
      {
        ...currentTranscript(),
        segments: [{ ...currentTranscript().segments[0], start: '0' }],
      },
    ],
  ] as const;

  it.each(invalid)(
    'rejects %s in machine, correction freeze and published readers',
    async (_name, data) => {
      await store(data);
      expect(await loadTranscript(root, HASH, BACKEND)).toBeNull();
      await expect(
        readMachineSource(root, HASH, BACKEND),
      ).rejects.toMatchObject({ code: 'SOURCE_MISSING' });
      expect(
        await loadPublishedTranscript('catalog', HASH, publication),
      ).toBeNull();
    },
  );

  it('requires every canonical metadata field', async () => {
    for (const field of [
      'model',
      'backend',
      'audio_filepath',
      'duration',
      'generation_params',
    ]) {
      const meta: Record<string, unknown> = { ...currentTranscript().meta };
      delete meta[field];
      await store({ ...currentTranscript(), meta });
      expect(await loadTranscript(root, HASH, BACKEND), field).toBeNull();
    }
  });

  it('allows an explicit empty transcript while rejecting malformed JSON', async () => {
    await store({ ...currentTranscript(), segments: [] });
    expect((await loadTranscript(root, HASH, BACKEND))?.segments).toEqual([]);
    await writeFile(file, '{');
    expect(await loadTranscript(root, HASH, BACKEND)).toBeNull();
  });

  it("matches the canonical schema's required fields, backend IDs and nullable confidence", async () => {
    const schema = JSON.parse(
      await readFile(
        path.resolve(__dirname, '../../../docs/schemas/transcript.schema.json'),
        'utf8',
      ),
    );
    const runtime = z.toJSONSchema(canonicalTranscriptSchema);
    expect(runtime).toMatchObject({
      required: schema.required,
      properties: {
        meta: {
          required: schema.properties.meta.required,
          properties: {
            backend: { enum: schema.properties.meta.properties.backend.enum },
          },
        },
        segments: {
          items: {
            required: schema.$defs.segment.required,
            properties: {
              words: { items: { required: schema.$defs.word.required } },
            },
          },
        },
      },
    });
    expect(schema.$defs.segment.properties.confidence.type).toContain('null');
    expect(schema.$defs.word.properties.confidence.type).toContain('null');
  });
});
