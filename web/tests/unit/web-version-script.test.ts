import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), '../scripts/resolve_web_version.sh');

describe('resolve_web_version.sh', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'besedy-web-version-'));
    git('init', '-q');
    git('config', 'user.name', 'Besedy Test');
    git('config', 'user.email', 'test@besedy.invalid');
    mkdirSync(resolve(repo, 'web'));
    writeFileSync(resolve(repo, 'web', 'app.ts'), 'export const value = 1;\n');
    writeFileSync(resolve(repo, 'README.md'), 'initial\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  }

  function resolveVersion() {
    return spawnSync('bash', [script, repo], { encoding: 'utf8' });
  }

  it('changes only when the tracked web tree changes', () => {
    const initial = resolveVersion();
    expect(initial.status).toBe(0);
    expect(initial.stdout.trim()).toBe(
      `web-v1-${git('rev-parse', 'HEAD:web')}`,
    );

    writeFileSync(resolve(repo, 'README.md'), 'root-only change\n');
    git('add', 'README.md');
    git('commit', '-qm', 'root change');
    expect(resolveVersion().stdout).toBe(initial.stdout);

    writeFileSync(resolve(repo, 'web', 'app.ts'), 'export const value = 2;\n');
    git('add', 'web/app.ts');
    git('commit', '-qm', 'web change');
    expect(resolveVersion().stdout).not.toBe(initial.stdout);
  });

  it('refuses dirty web sources', () => {
    writeFileSync(resolve(repo, 'web', 'app.ts'), 'dirty\n');

    const result = resolveVersion();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dirty web sources');
  });
});
