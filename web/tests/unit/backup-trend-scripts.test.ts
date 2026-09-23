import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptsDir = resolve(process.cwd(), 'scripts');
const healthCheck = join(scriptsDir, 'host-backup-health-check.sh');
const growthReport = join(scriptsDir, 'backup-growth-report.sh');
const worktreeReport = join(scriptsDir, 'worktree-report.sh');

let root = '';
let fakeBin = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'besedy-backup-trend-'));
  fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  // Keep tests out of syslog and away from real mail.
  writeExecutable(join(fakeBin, 'logger'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(fakeBin, 'sendmail'), '#!/bin/sh\ncat >/dev/null\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function writeFiles(dir: string, count: number) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `f${i}`), '');
}

function stamp(minutesAgo: number): string {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

type SyncRecord = { endMinutesAgo: number; durationMinutes: number; files: number };

function syncLog(records: SyncRecord[], trailer = ''): string {
  return (
    records
      .map(({ endMinutesAgo, durationMinutes, files }) =>
        [
          `[${stamp(endMinutesAgo + durationMinutes)}] Starting remote snapshot sync to host::module/`,
          '',
          `Number of files: ${files.toLocaleString('en-US')} (reg: ${files})`,
          'Total file size: 1.00G bytes',
          `[${stamp(endMinutesAgo)}] Remote snapshot sync completed successfully.`,
        ].join('\n'),
      )
      .join('\n') +
    '\n' +
    trailer
  );
}

const DAY = 24 * 60;

function runHealthCheck(
  projectRecords: SyncRecord[],
  options: { env?: Record<string, string>; projectTrailer?: string; requiredPath?: string } = {},
) {
  const projectRoot = join(root, 'rsnapshot');
  const extraRoot = join(root, 'rsnapshot_extra');
  mkdirSync(join(projectRoot, 'daily.0', 'projects', 'besedy'), { recursive: true });
  mkdirSync(join(extraRoot, 'daily.0', 'audio', 'x'), { recursive: true });
  mkdirSync(join(extraRoot, 'daily.0', 'state', 'db_dumps'), { recursive: true });
  writeFileSync(
    join(extraRoot, 'daily.0', 'state', 'db_dumps', 'besedy_20260101_000000.sql.gz'),
    '',
  );
  const mapFile = join(root, 'extra.paths');
  writeFileSync(mapFile, '/src/x|audio/x\n');

  const projectLog = join(root, 'project.log');
  const extraLog = join(root, 'extra.log');
  writeFileSync(projectLog, syncLog(projectRecords, options.projectTrailer));
  writeFileSync(extraLog, syncLog([{ endMinutesAgo: 60, durationMinutes: 1, files: 100 }]));

  const opsEnv = join(root, 'ops.env');
  writeFileSync(
    opsEnv,
    [
      `PROJECT_SNAPSHOT_ROOT=${projectRoot}`,
      `EXTRA_SNAPSHOT_ROOT=${extraRoot}`,
      `PROJECT_LOG_FILE=${projectLog}`,
      `EXTRA_LOG_FILE=${extraLog}`,
      '',
    ].join('\n'),
  );

  return spawnSync('bash', [healthCheck], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      BESEDY_OPS_ENV: opsEnv,
      EXTRA_MAP_FILE: mapFile,
      PROJECT_REQUIRED_PATHS: options.requiredPath ?? 'projects/besedy',
      ALERT_EMAIL: '',
      REPORT_EMAIL: '',
      ...options.env,
    },
  });
}

describe('scheduled monitoring scripts', () => {
  // The repo runs with core.fileMode=false, so a plain chmod never reaches git;
  // cron runs these by path and the weekly report skips non-executable helpers.
  it('are tracked as executable', () => {
    const result = spawnSync('git', ['ls-files', '-s', '--', 'scripts/*.sh'], {
      encoding: 'utf8',
    });
    const modes = result.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [mode, , , path] = line.split(/\s+/);
        return { mode, path };
      });

    expect(modes.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'scripts/backup-growth-report.sh',
        'scripts/host-backup-health-check.sh',
        'scripts/worktree-report.sh',
      ]),
    );
    expect(modes.filter(({ mode }) => mode !== '100755')).toEqual([]);
  });
});

describe('host-backup-health-check.sh remote sync trend', () => {
  it('stays healthy when the sync is quick and the file count is stable', () => {
    const result = runHealthCheck([
      { endMinutesAgo: 8 * DAY, durationMinutes: 30, files: 1000 },
      { endMinutesAgo: 60, durationMinutes: 30, files: 1100 },
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Host backup coverage OK');
    expect(result.stdout).toContain('project_remote_sync_duration_minutes=30');
    expect(result.stdout).toContain('project_remote_sync_files_growth_percent=10');
  });

  it('warns with exit code 3 when the latest sync is slow', () => {
    const result = runHealthCheck([
      { endMinutesAgo: 60, durationMinutes: 150, files: 1000 },
    ]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('Besedy host backup trend warning');
    expect(result.stdout).toContain(
      'Latest project remote sync took 150 min (threshold 120 min)',
    );
  });

  it('warns when the file count grew past the threshold over the window', () => {
    const result = runHealthCheck([
      { endMinutesAgo: 8 * DAY, durationMinutes: 30, files: 1000 },
      { endMinutesAgo: 60, durationMinutes: 30, files: 1300 },
    ]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('project remote sync file count grew 30%');
  });

  it('compares against a sync at least a window old, not the newest earlier one', () => {
    const result = runHealthCheck([
      { endMinutesAgo: 8 * DAY, durationMinutes: 30, files: 1000 },
      { endMinutesAgo: 2 * DAY, durationMinutes: 30, files: 500 },
      { endMinutesAgo: 60, durationMinutes: 30, files: 1100 },
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('project_remote_sync_files_growth_percent=10 (vs 1000');
  });

  it('ignores a failed sync attempt after the last success', () => {
    const result = runHealthCheck(
      [{ endMinutesAgo: 120, durationMinutes: 30, files: 1000 }],
      {
        projectTrailer: [
          `[${stamp(100)}] Starting remote snapshot sync to host::module/`,
          'rsync error: error in socket IO (code 10)',
          `[${stamp(10)}] Remote snapshot sync failed with exit code 10.`,
          '',
        ].join('\n'),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('project_remote_sync_duration_minutes=30');
  });

  it('keeps coverage failures fatal and lists trend warnings alongside them', () => {
    const result = runHealthCheck(
      [{ endMinutesAgo: 60, durationMinutes: 150, files: 1000 }],
      { requiredPath: 'projects/missing' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('coverage check failed');
    expect(result.stdout).toContain('Warnings:');
    expect(result.stdout).toContain('took 150 min');
  });

  it('rejects a non-positive trend threshold', () => {
    const result = runHealthCheck([], {
      env: { REMOTE_SYNC_MAX_GROWTH_PERCENT: '0' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'REMOTE_SYNC_MAX_GROWTH_PERCENT must be a positive integer',
    );
  });
});

describe('backup-growth-report.sh', () => {
  function runGrowthReport(env: Record<string, string> = {}) {
    const snapshots = join(root, 'rsnapshot');
    const opsEnv = join(root, 'ops.env');
    writeFileSync(opsEnv, `PROJECT_SNAPSHOT_ROOT=${snapshots}\n`);
    return spawnSync('bash', [growthReport], {
      encoding: 'utf8',
      env: { ...process.env, BESEDY_OPS_ENV: opsEnv, ...env },
    });
  }

  it('lists directories that grew between the oldest and newest daily', () => {
    const snapshots = join(root, 'rsnapshot');
    writeFiles(join(snapshots, 'daily.0', 'projects', 'app'), 5);
    writeFiles(join(snapshots, 'daily.0', 'projects', 'fresh-worktree'), 2);
    writeFiles(join(snapshots, 'daily.0', 'projects', 'steady'), 1);
    // daily.1 is newer than daily.3 and must not be used as the baseline.
    writeFiles(join(snapshots, 'daily.1', 'projects', 'other'), 1);
    writeFiles(join(snapshots, 'daily.3', 'projects', 'app'), 1);
    writeFiles(join(snapshots, 'daily.3', 'projects', 'steady'), 1);

    const result = runGrowthReport();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Files in projects/: 4 ');
    expect(result.stdout).toMatch(/\+4\s+2 -> 6\s+app\n/);
    expect(result.stdout).toMatch(/\+3\s+0 -> 3\s+fresh-worktree \(new\)/);
    expect(result.stdout).not.toContain('steady');
  });

  it('honors the listing limit', () => {
    const snapshots = join(root, 'rsnapshot');
    writeFiles(join(snapshots, 'daily.0', 'projects', 'big'), 9);
    writeFiles(join(snapshots, 'daily.0', 'projects', 'small'), 1);
    writeFiles(join(snapshots, 'daily.2', 'projects', 'keep'), 1);

    const result = runGrowthReport({ GROWTH_REPORT_LIMIT: '1' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('big (new)');
    expect(result.stdout).not.toContain('small');
  });

  it('explains when there is nothing to compare yet', () => {
    writeFiles(join(root, 'rsnapshot', 'daily.0', 'projects', 'app'), 1);

    const result = runGrowthReport();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Need at least two daily snapshots');
  });
});

describe('worktree-report.sh', () => {
  const gitEnv = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };

  function git(cwd: string, ...args: string[]) {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...gitEnv },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  function setUpRepo() {
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(root, 'init', '-b', 'main', repo);
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-u', 'origin', 'main');
    return repo;
  }

  function addWorktree(repo: string, name: string, ...extra: string[]) {
    const path = join(root, 'wt', name);
    git(repo, 'worktree', 'add', '--detach', path, 'main', ...extra);
    return path;
  }

  function backdateGitActivity(worktree: string) {
    const gitDir = git(worktree, 'rev-parse', '--absolute-git-dir');
    const old = new Date(Date.now() - 10 * DAY * 60_000);
    for (const file of ['HEAD', 'index', 'logs/HEAD']) {
      utimesSync(join(gitDir, file), old, old);
    }
  }

  function runWorktreeReport(repo: string, env: Record<string, string> = {}) {
    return spawnSync('bash', [worktreeReport], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...gitEnv,
        WORKTREE_REPORT_REPOS: repo,
        WORKTREE_BACKUP_TREE: join(root, 'wt'),
        WORKTREE_REPORT_DOCKER: join(fakeBin, 'no-docker'),
        ...env,
      },
    });
  }

  it('marks only clean, pushed, idle, unused worktrees as removable', () => {
    const repo = setUpRepo();
    const clean = addWorktree(repo, 'clean');
    const dirty = addWorktree(repo, 'dirty');
    writeFileSync(join(dirty, 'notes.txt'), 'wip\n');
    const unpushed = addWorktree(repo, 'unpushed');
    writeFileSync(join(unpushed, 'change.txt'), 'x\n');
    git(unpushed, 'add', 'change.txt');
    git(unpushed, 'commit', '-m', 'local only');
    const container = addWorktree(repo, 'container');
    writeExecutable(
      join(fakeBin, 'fake-docker'),
      `#!/bin/sh\necho "${container}/web"\n`,
    );
    const missing = addWorktree(repo, 'missing');
    rmSync(missing, { recursive: true, force: true });
    for (const wt of [clean, dirty, unpushed, container]) backdateGitActivity(wt);

    const result = runWorktreeReport(repo, {
      WORKTREE_REPORT_DOCKER: join(fakeBin, 'fake-docker'),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Linked git worktrees: 5 (1 removable, 3 kept, 1 with missing directories)',
    );
    expect(result.stdout).toMatch(new RegExp(`REMOVABLE  ${clean} .*\\(inside backup tree\\)`));
    expect(result.stdout).toMatch(new RegExp(`KEEP       ${dirty} .*uncommitted changes`));
    expect(result.stdout).toMatch(
      new RegExp(`KEEP       ${unpushed} .*commits not on any remote branch`),
    );
    expect(result.stdout).toMatch(
      new RegExp(`KEEP       ${container} .*used by a Docker container`),
    );
    expect(result.stdout).toContain(`PRUNE      ${missing}`);
    expect(result.stdout).toContain(`git -C ${repo} worktree remove ${clean}`);
    expect(result.stdout).not.toContain(`worktree remove ${dirty}`);
  });

  it('keeps a recently active worktree and does not refresh its index', () => {
    const repo = setUpRepo();
    const recent = addWorktree(repo, 'recent');

    const result = runWorktreeReport(repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`KEEP       ${recent} .*active in the last 3 days`));

    backdateGitActivity(recent);
    const afterBackdate = runWorktreeReport(repo);
    // A second run must still see it as idle: the report itself is not activity.
    const again = runWorktreeReport(repo);
    expect(afterBackdate.stdout).toContain(`REMOVABLE  ${recent}`);
    expect(again.stdout).toContain(`REMOVABLE  ${recent}`);
  });

  it('keeps a worktree that a running process is using', async () => {
    const repo = setUpRepo();
    const busy = addWorktree(repo, 'busy');
    backdateGitActivity(busy);
    const sleeper = spawn('sleep', ['30'], { cwd: busy, stdio: 'ignore' });
    try {
      await new Promise((ready) => setTimeout(ready, 100));
      const result = runWorktreeReport(repo);
      expect(result.stdout).toMatch(
        new RegExp(`KEEP       ${busy} .*a running process is inside it`),
      );
    } finally {
      sleeper.kill();
    }
  });

  it('rejects an invalid idle threshold', () => {
    const repo = setUpRepo();
    const result = runWorktreeReport(repo, { WORKTREE_MIN_IDLE_DAYS: 'soon' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('WORKTREE_MIN_IDLE_DAYS must be a non-negative integer');
  });
});
