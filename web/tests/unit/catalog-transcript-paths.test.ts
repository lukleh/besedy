import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import contract from '../../../contracts/catalog-transcript-paths.json';
import { clearConfigCache } from '@/lib/config';
import { getTranscriptsBaseDir, resolveTranscriptsPath } from '@/lib/paths';

describe('catalog transcript path contract', () => {
  let temporary: string;
  let textRoot: string;

  function configureParent(parent?: string) {
    const configPath = path.join(temporary, 'besedy.toml');
    fs.writeFileSync(
      configPath,
      `[paths]\ntext_data_dir = ${JSON.stringify(textRoot)}\n` +
        (parent === undefined
          ? ''
          : `transcripts_dir = ${JSON.stringify(parent)}\n`),
    );
    vi.stubEnv('BESEDY_CONFIG', configPath);
    clearConfigCache();
  }

  beforeEach(() => {
    temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'besedy-transcript-paths-'),
    );
    textRoot = path.join(temporary, 'text');
    configureParent();
  });

  afterEach(() => {
    clearConfigCache();
    vi.unstubAllEnvs();
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it('defaults to the same parent as the pipeline and worker', () => {
    expect(getTranscriptsBaseDir()).toBe(path.join(textRoot, contract.parent));
    configureParent('');
    expect(getTranscriptsBaseDir()).toBe(path.join(textRoot, contract.parent));
  });

  it.each(contract.generations)(
    'resolves $catalogId',
    ({ catalogId, directory }) => {
      expect(resolveTranscriptsPath(catalogId)).toBe(
        path.join(textRoot, contract.parent, directory),
      );
    },
  );

  it.each(contract.customParents)(
    'preserves artifacts in $configured without following a latest symlink',
    ({ configured, relative: relativeParent }) => {
      configureParent(configured);
      const transcriptsParent = path.join(textRoot, relativeParent);
      const generation = path.join(
        transcriptsParent,
        'transcripts_20251225_120000',
      );
      const relative = path.join(
        'faster-whisper/model@lang-cs',
        'a'.repeat(64),
        'transcript.json',
      );
      const artifact = path.join(generation, relative);
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, '{"segments": []}');
      const latest = path.join(
        transcriptsParent,
        'transcripts_20261108_230000',
      );
      fs.mkdirSync(latest);
      fs.symlinkSync(
        latest,
        path.join(transcriptsParent, 'transcripts'),
        'dir',
      );

      expect(getTranscriptsBaseDir()).toBe(transcriptsParent);
      expect(resolveTranscriptsPath('20251225_120000')).toBe(generation);
      expect(
        fs.readFileSync(
          path.join(resolveTranscriptsPath('20251225_120000'), relative),
          'utf8',
        ),
      ).toBe('{"segments": []}');
    },
  );

  it.each(contract.invalidCatalogIds)(
    'refuses an invalid generation ID %j',
    (id) => {
      expect(() => resolveTranscriptsPath(id)).toThrow();
    },
  );
});
