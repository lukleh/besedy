# Backup Layout

Besedy uses two host-side rsnapshot roots.

- `rsnapshot_projects` at `/mnt/data/<user>/Backups/rsnapshot`
  - generic backup of `/home/<user>/projects`
  - includes `projects/besedy`, `projects/besedy_data`, `projects/besedy_posters`, and `projects/besedy_sources`
- `rsnapshot_besedy_extra` at `/mnt/data/<user>/Backups/rsnapshot_besedy_extra`
  - Besedy-specific non-project paths that are not covered by the generic project backup

The extra snapshot root is driven by `/home/<user>/projects/back_up.sh` with
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

Recommended host crontab for the extra root:

```cron
0 15 * * *   SNAPSHOT_MAP_FILE="/home/<user>/projects/besedy/web/setup/backup/besedy-extra.paths" SNAPSHOT_ROOT="/mnt/data/<user>/Backups/rsnapshot_besedy_extra" RSNAPSHOT_CONFIG="/home/<user>/.config/rsnapshot_besedy_extra.conf" LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.log" DETAIL_LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.detail.log" LOCK_FILE="/tmp/besedy_extra_rsnapshot.lock" RSNAPSHOT_LOCK_FILE="/tmp/besedy_extra_rsnapshot.pid" SYNC_TARGET="<backup-user>@<backup-host>::LinuxBackups/rsnapshot_besedy_extra/" ALERT_EMAIL="..." /home/<user>/projects/back_up.sh daily
10 15 * * 0  SNAPSHOT_MAP_FILE="/home/<user>/projects/besedy/web/setup/backup/besedy-extra.paths" SNAPSHOT_ROOT="/mnt/data/<user>/Backups/rsnapshot_besedy_extra" RSNAPSHOT_CONFIG="/home/<user>/.config/rsnapshot_besedy_extra.conf" LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.log" DETAIL_LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.detail.log" LOCK_FILE="/tmp/besedy_extra_rsnapshot.lock" RSNAPSHOT_LOCK_FILE="/tmp/besedy_extra_rsnapshot.pid" SYNC_TARGET="<backup-user>@<backup-host>::LinuxBackups/rsnapshot_besedy_extra/" ALERT_EMAIL="..." /home/<user>/projects/back_up.sh weekly
20 15 1 * *  SNAPSHOT_MAP_FILE="/home/<user>/projects/besedy/web/setup/backup/besedy-extra.paths" SNAPSHOT_ROOT="/mnt/data/<user>/Backups/rsnapshot_besedy_extra" RSNAPSHOT_CONFIG="/home/<user>/.config/rsnapshot_besedy_extra.conf" LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.log" DETAIL_LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.detail.log" LOCK_FILE="/tmp/besedy_extra_rsnapshot.lock" RSNAPSHOT_LOCK_FILE="/tmp/besedy_extra_rsnapshot.pid" SYNC_TARGET="<backup-user>@<backup-host>::LinuxBackups/rsnapshot_besedy_extra/" ALERT_EMAIL="..." /home/<user>/projects/back_up.sh monthly
30 15 1 1 *  SNAPSHOT_MAP_FILE="/home/<user>/projects/besedy/web/setup/backup/besedy-extra.paths" SNAPSHOT_ROOT="/mnt/data/<user>/Backups/rsnapshot_besedy_extra" RSNAPSHOT_CONFIG="/home/<user>/.config/rsnapshot_besedy_extra.conf" LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.log" DETAIL_LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.detail.log" LOCK_FILE="/tmp/besedy_extra_rsnapshot.lock" RSNAPSHOT_LOCK_FILE="/tmp/besedy_extra_rsnapshot.pid" SYNC_TARGET="<backup-user>@<backup-host>::LinuxBackups/rsnapshot_besedy_extra/" ALERT_EMAIL="..." /home/<user>/projects/back_up.sh yearly
```
