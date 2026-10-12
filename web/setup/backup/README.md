# Backup Layout

Besedy uses two host-side rsnapshot roots.

- `rsnapshot_projects` at `/mnt/data/<user>/Backups/rsnapshot`
  - generic backup of `/home/<user>/projects`
  - includes `projects/besedy`, `projects/besedy_data`, `projects/besedy_artwork`, and `projects/besedy_sources`
- `rsnapshot_besedy_extra` at `/mnt/data/<user>/Backups/rsnapshot_besedy_extra`
  - Besedy-specific non-project paths that are not covered by the generic project backup

The extra snapshot root is driven by [rsnapshot-backup.sh](../../scripts/rsnapshot-backup.sh) with
`SNAPSHOT_MAP_FILE` pointing at your `besedy-extra.paths` (gitignored; copy it
from [besedy-extra.paths.example](./besedy-extra.paths.example)).

Current labels inside `rsnapshot_besedy_extra/<interval>.N/`:

- `audio/besedy_audio`
- `audio/original`
- `state/db_dumps`
- `config/lukleh_besedy`
- `state/web_logs`

Example tree:

```text
/mnt/data/<user>/Backups/rsnapshot_besedy_extra/
  daily.0/
    audio/
      besedy_audio/
      original/
    state/
      db_dumps/
      web_logs/
    config/
      lukleh_besedy/
```

The weekly report and `host-backup-health-check.sh` validate Besedy coverage
across both snapshot roots. Both read their snapshot-root and log-file paths
from an ops env file: copy [ops.env.example](./ops.env.example) to
`~/.config/lukleh/besedy/ops.env` (or set `BESEDY_OPS_ENV`); they exit with an
error if a path is unset.

The remote sync copies every retained snapshot and preserves hard links, so its
run time grows with the file count per snapshot times the number of snapshots.
`host-backup-health-check.sh` warns when that sync gets slow or the synced file
count jumps; `web/scripts/backup-growth-report.sh` shows which top-level
directories caused it. Keep regenerable trees (dependency folders, caches,
throwaway git worktrees) out of `~/projects` or in the backup exclude file.

## Host runner configuration

The versioned runner contains no host-specific defaults for sources, snapshot
roots, logs, locks, NAS addresses, password files, or alert recipients. Copy
[snapshot.env.example](./snapshot.env.example) into a private location outside
the checkout, create a separate profile for each snapshot root, and set its
permissions to `0600`. The profile is trusted shell configuration, like `ops.env`;
quote paths containing spaces. A profile may source the private `ops.env` to
reuse the monitoring paths and NAS settings.

Use `SOURCE_DIR` for the project profile and `SNAPSHOT_MAP_FILE` for the extra
profile. Configure each profile's existing snapshot root, generated rsnapshot
config, logs, locks, sync destination, credential file, exclusions, and retention.
Keep its values consistent with the monitoring settings in `ops.env`.

```bash
SNAPSHOT_ENV_FILE=/path/to/private/projects.env bash web/scripts/rsnapshot-backup.sh daily
SNAPSHOT_ENV_FILE=/path/to/private/extra.env bash web/scripts/rsnapshot-backup.sh daily
```

Settings may instead be supplied directly as environment variables. Missing
required paths fail explicitly; there is no fallback to a particular host.
Install `rsnapshot`, `rsync`, `flock`, Docker Compose, and `jq` before scheduling
the jobs. The repository now includes the runner that invokes the hooks, so a
replacement host does not need an unversioned snapshot implementation.

## Daily database backup

The `backup` Compose service is a one-shot dump, not a continuously running
container. The daily extra snapshot job invokes `db-snapshot-hook.sh before`
under its existing snapshot lock, creates and validates a fresh dump, then
snapshots and syncs normally. Its `after` hook downloads that exact dump from
the NAS and compares SHA-256 and gzip integrity with the fresh source. Hook
failures cause an alert and a nonzero job result; a failed dump does not prevent
the ordinary audio and other data backup.

Set `BESEDY_COMPOSE_DIR` to the production deployment's `web` directory and set
both `BEFORE_SNAPSHOT_HOOK` and `AFTER_SYNC_HOOK` to its
`web/scripts/db-snapshot-hook.sh` in the private extra profile. The versioned
runner invokes these hooks, exports its snapshot settings, and keeps its existing
snapshot lock until verification finishes. Weekly/monthly/yearly jobs are unchanged.

Configure `DB_BACKUP_REMOTE_TARGET`, `DB_BACKUP_PASSWORD_FILE`, and
`DB_BACKUP_MAX_AGE_HOURS=24` in `ops.env`. The remote target must match that
job's `SYNC_TARGET`, including its trailing slash. The Compose backup mount
must match `BACKUP_DIR`; its snapshot map must use the `state/db_dumps` label.
The source directory retains seven automatic dump files; versioned snapshots
retain the older recovery points according to their existing retention settings.
Dump filenames use UTC timestamps.

Successful NAS readback writes `BACKUP_DIR/.nas-verified.tsv` atomically with
the dump name, dump-start timestamp, checksum, verification time, and remote
target. The daily host health check reads this receipt, enforces the 24-hour
dump-age limit, and downloads and checks the NAS copy again. It does not treat
the existence of a local dump or a recent sync log as proof of a fresh NAS copy.
The local dump health check expects no permanently running backup container.

The schedule remains once daily. Actual dump and transfer time can make the
previous recovery point slightly older than 24 hours while the next run finishes;
a missed or failed run must not silently show healthy status.

Avoid overlapping scheduled dumps, manual/deployment dumps, and restores.
Pause the schedule and wait for active dumps to finish before database
maintenance. This coordination is the operator's responsibility; stopping the
regular Compose backup service alone does not pause the host schedule.

To test restoration, download a trusted dump from the NAS into a private recovery
directory and run `bash web/scripts/db-backup-restore-test.sh /path/to/dump.sql.gz`.
It uses an already installed `pgvector/pgvector:pg18` image, with no network,
published ports, persistent DB volume, or production mounts. It restores into a
temporary RAM-backed database, checks tables and app-role access, and removes
the test container on exit. This is a manual drill, not an additional schedule.

Recommended host crontab for the extra root:

```cron
0 15 * * * SNAPSHOT_ENV_FILE="/path/to/private/extra.env" bash /path/to/besedy/web/scripts/rsnapshot-backup.sh daily
10 15 * * 0 SNAPSHOT_ENV_FILE="/path/to/private/extra.env" bash /path/to/besedy/web/scripts/rsnapshot-backup.sh weekly
20 15 1 * * SNAPSHOT_ENV_FILE="/path/to/private/extra.env" bash /path/to/besedy/web/scripts/rsnapshot-backup.sh monthly
30 15 1 1 * SNAPSHOT_ENV_FILE="/path/to/private/extra.env" bash /path/to/besedy/web/scripts/rsnapshot-backup.sh yearly
```
