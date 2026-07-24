# Scheduled Monitoring Scripts

This directory is for recurring host-scheduled monitoring and reporting scripts
for the web stack.

Canonical documentation:

- [docs/web/operations.md](../../docs/web/operations.md)
- [web/setup/backup/README.md](../setup/backup/README.md) for the separate
  host-side `back_up.sh` rsnapshot jobs

`backup-health-check.sh`, `host-backup-health-check.sh`, and `weekly-report.sh`
require an ops env file for their filesystem paths: copy
`web/setup/backup/ops.env.example` to `~/.config/lukleh/besedy/ops.env` (or set
`BESEDY_OPS_ENV`). They exit with an error if a required path is unset.

Current host schedule was verified on 2026-04-22:

- `audit-check.sh` at `06:00` daily
- `weekly-report.sh` at `06:30` on Sunday
- `backup-health-check.sh` at `06:45` daily
- `host-backup-health-check.sh` at `07:05` daily
- `security-update-check.sh` at `07:00` on day `1` of each month

What belongs here:

- scripts intended to run from cron or a user crontab
- scripts that send recurring emails or write recurring monitoring logs

What does not belong here:

- one-time host setup assets
- boot-time hardening files such as the egress controls under `web/setup/egress/`
