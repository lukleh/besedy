# Web Operations

> **Last Updated:** 2026-04-22

Operational reference for deploying, monitoring, and running the Besedy web app.
For security hardening details see `docs/web/security.md`.
For shared repo workflow and justfile commands see `AGENTS.md`.

---

## Environments

| Environment | Web Port | DB Port | Preferred Command | Compose Overlay |
|-------------|----------|---------|-------------------|-----------------|
| Development | 3001 | 5433 | `just dev-up` | `docker-compose.dev.yml` + `mock-oauth` profile |
| Test (E2E) | 3002 | 5434 | `just test-up` | `docker-compose.secure.yml` (production-style) |
| Production | 3000 | 5432 | `just prod-up` | `docker-compose.secure.yml` + `docker-compose.production.yml` + `backup` profile |

All three stacks can run simultaneously -- they use separate ports, volumes, and
container name prefixes (`besedy-development-*`, `besedy-test-*`,
`besedy-production-*`).

Always use the `just` recipes or `scripts/run_web_compose.sh`. The wrapper clears
unrelated shell state, fixes the Compose identity independently from runtime
`APP_ENV`, and validates the fully rendered configuration before Docker can
create, replace, stop, or remove resources.

---

## Development Setup

Start the dev stack:

```bash
just dev-up
```

- Web: `http://localhost:3001`, DB: `localhost:5433`
- Uses mock OAuth -- no real Google credentials needed.
- pgAdmin available via `just dev-up-tools` at `http://localhost:5050`.

Useful follow-ups: `just web-check`, `just dev-logs`, `just dev-down`.

### Test / E2E Stack

```bash
just test-up          # starts stack and seeds test DB
just test-reset       # mid-session DB reset
cd web && npm run test:e2e
```

Runs on `http://localhost:3002` against the secure compose overlay.

### LAN / Tailscale Access

Set `AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `AUTH_EXTRA_ORIGINS`, and
`AUTH_DEV_TRUSTED_ORIGINS` to full LAN/Tailscale origins, including the scheme
and port. Set `DEV_EXTRA_ORIGINS` to comma-separated hostnames or IP addresses
without a scheme or port. Service workers require HTTPS, so offline audio
caching does not work over plain HTTP from another device.

---

## Production Deploy

### Architecture

```
User -> Cloudflare Tunnel (TLS) -> localhost:3000 -> besedy-production-web -> Postgres
```

Cloudflare terminates TLS and enforces access policies. The web container reads
catalogs, transcripts, and audio from mounted host paths.

### Deploy Preflight Checklist

**Resolved production env file** (`BESEDY_WEB_ENV_PROD` or `~/.config/lukleh/besedy/web.env.prod`):

- [ ] `POSTGRES_PASSWORD`, `MIGRATE_PASSWORD`, `APP_PASSWORD`
- [ ] `DATABASE_URL` using least-privilege app user
- [ ] `AUTH_SECRET`
- [ ] `AUTH_URL` (must match domain and OAuth redirect URI)
- [ ] `NEXT_PUBLIC_APP_URL` matches `AUTH_URL`
- [ ] `TEXT_DATA_DIR`, `POSTERS_DIR`, `SOURCES_DIR`
- [ ] `AUDIO_DIR`, `ORIGINAL_AUDIO_DIR`
- [ ] `BACKUP_DIR` (outside container mounts)
- [ ] `WEB_LOGS_DIR` (persisted web logs on host)
- [ ] `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`

**`besedy.toml`:**

- [ ] `superadmin_email` configured under `[web]`
- [ ] Container data paths set (`/data/text`, `/data/audio`)

**Infrastructure:**

- [ ] Cloudflare Tunnel pointing to `localhost:3000`
- [ ] Google OAuth redirect URI matches `AUTH_URL`
- [ ] External DB volume exists: `docker volume inspect besedy_production_postgres`

On a new host, create the production DB volume once before the first deployment:

```bash
docker volume create besedy_production_postgres
```

Production mounts this external volume at `/var/lib/postgresql`, as required by
the PostgreSQL 18 image layout. Because it is external, `just prod-down-clean`
does not delete database data.

Routine `just prod-up` uses `--no-recreate`; DB container replacement belongs
only in an explicit, backed-up maintenance procedure.

### Release Preflight

- [ ] Deploy from a clean checkout of the intended commit
- [ ] Keep `CONFIG_FILE` on an absolute path outside the checkout; the deploy
      preflight requires a regular file readable by the unprivileged web container
- [ ] Record current deployed version: `curl -s https://besedy.org/api/version | jq`
- [ ] `just web-check` on the release candidate
- [ ] `cd web && npm run test:e2e:smoke` for production smoke coverage
- [ ] For broad or auth-sensitive releases: `cd web && npm run test:e2e`
- [ ] Check whether `web/prisma/migrations/` changed
- [ ] Verify `AUTH_URL` still matches `NEXT_PUBLIC_APP_URL`
- [ ] Verify latest backup exists in `BACKUP_DIR`

### Release Workflow

**Start the existing production stack (no rebuild):**

```bash
just prod-up
```

**Deploy the current checkout with rebuild, checks, and migrations:**

```bash
just prod-deploy
```

`prod-deploy` scopes `docker compose up` to the `web` service only, avoiding DB
container recreation (which can corrupt indexes). Its `prod-migrate` step grants
the app access to newly migrated tables and then re-applies the `audit_log`
DELETE revoke.

**Version tracking:** The build keeps `GIT_COMMIT` for deployment diagnostics
and derives `WEB_VERSION` from an allowlist of production web inputs plus the
browser-visible build configuration. Root-only, jobs/Python, web test, and web
documentation commits therefore do not replace the service worker. Dirty web
checkouts are still rejected to keep production builds reproducible.
Both identifiers are visible at `GET /api/version`; the admin sidebar continues
to display the source commit. Update lifecycle telemetry is available under
**Admin → Web Updates** and is retained for 30 days.

**Fresh database caveat:** On a brand-new DB from the full migration chain,
install the `vector` extension before the first migration:

```bash
docker exec besedy-production-db psql -U besedy -d besedy -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

This is only needed because older migrations create `vector` columns before later
migrations remove them. Existing databases that already passed that point need
nothing.

**First-deployment extras** (run once, not on every release):

1. Install egress hardening: copy `web/setup/egress/` assets, enable `besedy-egress.service`.
2. Install monitoring cron jobs (see Monitoring section below).

### Post-Deploy Verification

- [ ] `just prod-status` shows healthy services
- [ ] Site loads at production URL, Google OAuth sign-in works
- [ ] First sign-in with `superadmin_email` gets admin role
- [ ] Catalog upload and audio streaming work
- [ ] `just prod-monitor` (session health -- see below)
- [ ] Backups appearing in `BACKUP_DIR`
- [ ] Daily logs appearing in `WEB_LOGS_DIR`
- [ ] `sudo systemctl status besedy-egress` confirms LAN blocked

### Session Health Monitor

After auth/session-affecting deploys:

```bash
just prod-monitor       # last 24h (default)
just prod-monitor 6     # last 6h
```

Checks: login frequency (>3 logins = session issue), client errors, server auth
errors, active/expired session counts, session endpoint health, deployed version.

---

## Rollback

1. Check out the previous known-good commit.
2. Redeploy: `just prod-deploy`.
3. If a migration must be reverted, restore the database from backup:

```bash
cd web
bash ../scripts/run_web_compose.sh production stop web
gunzip -c /path/to/backup.sql.gz | \
  bash ../scripts/run_web_compose.sh production \
  exec -T db psql -U besedy -d besedy
bash ../scripts/run_web_compose.sh production start web
```

4. Verify rollback: `curl -s https://besedy.org/api/version | jq`.

---

## Deep Search Production Runtime

Deep Search runs *outside* the Next.js app: a shared Prefect control plane plus a
per-environment jobs runtime (jobs API + worker), all joined to the
`besedy-internal` Docker network alongside production web. See
[docker-container-topology.md](docker-container-topology.md) for the full
container/network map. **Prefect is shared across environments; the jobs runtime
is not** -- dev and prod each run their own, so a production job never routes
through the development runtime.

### Deploy Order

1. **Web + migrations** -- `just prod-deploy` (see Production Deploy above).
   Set `JOBS_API_BASE_URL=http://besedy-prod-jobs-api:8390` in the production web
   env file so web calls the production jobs API by container name. Do **not**
   use `besedy-jobs-api` (that DNS alias belongs to the dev runtime), and note the
   compose default (`http://jobs-api:8390`) resolves to nothing in production, so
   this value must be set explicitly. Web joins `besedy-internal` on container
   (re)creation via the compose `networks:` block -- under either `prod-up` or
   `prod-deploy`; use `prod-deploy` for a release because it also rebuilds the
   image and runs migrations, not because it is the only recipe that joins the
   network. `prod-up`, `prod-deploy`, and `jobs-prod-up` create the external
   `besedy-internal` network if it is missing.
2. **Shared Prefect + production runtime:**

   Before the first hardened deployment, create the output root and make it
   writable by `JOBS_CONTAINER_UID:JOBS_CONTAINER_GID` (defaults `1000:1000`):

   ```bash
   install -d -m 0750 ~/.local/state/lukleh/besedy/deep-search
   chown -R 1000:1000 ~/.local/state/lukleh/besedy/deep-search
   ```

   If production uses a `model-chatgpt-*` profile, set
   `CODEX_HOST_AUTH_FILE` to an existing `auth.json` and use
   `just jobs-prod-up-codex`; only that file is mounted into the worker.
   OpenRouter/NVIDIA profiles should use the regular `jobs-prod-up`, which does
   not expose Codex credentials at all.

   ```bash
   just prefect-up      # shared Prefect control plane (keep its Postgres volume)
   just jobs-prod-up    # locked image build + hardened API/worker startup
   # or, only for model-chatgpt-* profiles:
   just jobs-prod-up-codex
   ```

   `jobs-prod-up` refuses a dirty Besedy worktree, labels the image with the
   Besedy revision and build time, then starts both services with `--no-build`.
   The image build refreshes the public `rlmbenchy` repository's default branch
   and packages the resolved revision into the image. Running containers
   therefore execute immutable packaged image code rather than a mutable
   repository bind mount.

   The Python dependency audit has one explicit accepted-risk exception:
   `PYSEC-2026-2447` for DiskCache's pickle serialization. DSPy uses DiskCache
   only in the worker-owned cache at `DSPY_CACHEDIR`; production places that
   cache on the ephemeral, non-root `/tmp` filesystem. Remove the exception
   when DiskCache publishes a fixed release.

3. **Register the Prefect deployment:**

   ```bash
   just jobs-prod-deploy
   ```

   Registers/refreshes the `besedy-deep-search-prod` work pool and the
   `deep_search_flow/deep-search-prod` deployment (concurrency from
   `PREFECT_DEEP_SEARCH_CONCURRENCY_LIMIT`). Use `just jobs-dev-deploy` for
   development; the bare `just jobs-deploy` alias targets **dev**.

### Verification

```bash
# web + jobs health
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/version | jq   # shows the newly deployed commit

# production containers share besedy-internal
docker network inspect besedy-internal \
  | jq -r '.[].Containers | to_entries[] | .value.Name'
# expect: besedy-production-web, besedy-prod-jobs-api, besedy-prod-prefect-worker

# web -> jobs API reachability (network only -- does NOT check web's configured
# JOBS_API_BASE_URL; prod container names, besedy-jobs-api is the dev runtime)
docker exec besedy-production-web wget -qO- http://besedy-prod-jobs-api:8390/health

# worker -> web
docker exec besedy-prod-prefect-worker python -c \
  "from urllib.request import urlopen; print(urlopen('http://besedy-production-web:3000/api/health', timeout=5).read().decode())"

# image provenance and runtime hardening
docker image inspect besedy-jobs:prod \
  --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
docker inspect besedy-prod-prefect-worker \
  --format 'user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} caps={{json .HostConfig.CapDrop}}'
```

Then submit one small Deep Search job through the UI and confirm a
`<flow-run-id>` directory appears under the configured deep-search state dir
(e.g. `~/.local/state/lukleh/besedy/deep-search/prod/`).

### Rollback

- Jobs failed while web is healthy: `just jobs-prod-down`. **Do not** use
  `just jobs-down` -- it is a backward-compatible alias for the **dev** runtime.
  Deep Search goes offline while the catalog web app and dev runtime keep
  running.
- The Deep Search share table is additive -- do not drop it manually unless
  there is a concrete data or availability problem.

### Known Risks

- **Wrong runtime.** Reusing the dev runtime for production routes prod jobs
  through development (wrong web target and output env). Share Prefect, not the
  runtime.
- **Secret mismatch.** `BESEDY_JOB_SERVICE_SECRET` must match between web and the
  jobs runtime; a mismatch breaks calls in **both** directions.
- **Web not recreated.** If production web is not recreated after a release it
  will not join `besedy-internal`, and the worker cannot reach it.
- **Host ownership mismatch.** The worker is deliberately non-root. Its
  `JOBS_CONTAINER_UID:JOBS_CONTAINER_GID` must own the deep-search state root;
  do not restore root execution or broad capabilities to work around ownership.
- Do not run `npm audit fix --force` as part of a rollout.

---

## Cloudflare Tunnel

### What It Does

Routes `public hostname -> Cloudflare Tunnel -> localhost:3000 -> besedy-production-web`.
The web service stays bound to localhost. Cloudflare handles public TLS.

### Bootstrap (condensed)

1. `cloudflared tunnel login` and `cloudflared tunnel create besedy-tunnel`.
2. Copy credentials to `/etc/cloudflared/` (`cert.pem`, `<TUNNEL_ID>.json`).
3. Write `/etc/cloudflared/config.yml` with ingress rules pointing hostnames to `http://localhost:3000` and a catch-all `http_status:404`.
4. `cloudflared tunnel route dns besedy-tunnel <hostname>`.
5. `sudo cloudflared --config /etc/cloudflared/config.yml service install && sudo systemctl enable --now cloudflared`.
6. Set `AUTH_URL` and `NEXT_PUBLIC_APP_URL` to match the tunnel hostname, then deploy.

### Service Management

```bash
sudo systemctl status cloudflared
sudo systemctl restart cloudflared
sudo journalctl -u cloudflared -f
```

### Common Failures

**Tunnel not connecting:**
- Validate `/etc/cloudflared/config.yml` and credentials file path.
- Inspect `journalctl -u cloudflared`.

**502 / origin unavailable:**
- Confirm the web container is healthy (`just prod-status`).
- Confirm ingress points to `http://localhost:3000`.

**Auth callback mismatch / DNS mismatch:**
- `AUTH_URL` and `NEXT_PUBLIC_APP_URL` must exactly match the public hostname.
- Rebuild or restart the web container after correcting the env file.

---

## Monitoring & Alerts

All monitoring scripts live in `web/scripts/`. Host setup assets (egress
hardening) live in `web/setup/`.

### Script Inventory

| Script | Schedule | Alerts When | Logger Tag |
|--------|----------|-------------|------------|
| `audit-check.sh` | Daily 06:00 | Failed logins or access denials exceed thresholds; admin role changes | `besedy-audit` |
| `weekly-report.sh` | Weekly Sun 06:30 | Every run (full 7-day activity summary) | `besedy-weekly` |
| `backup-health-check.sh` | Daily 06:45 | Any backup health check fails | `besedy-backup` |
| `host-backup-health-check.sh` | Daily 07:05 | Any required project/extra snapshot coverage check fails | `besedy-host-backup` |
| `security-update-check.sh` | Monthly 1st 07:00 | Every run (subject varies by findings) | `besedy-security` |

All scripts require: Docker access, production compose files, resolved
production env file via `scripts/resolve_web_env_file.sh production`, `sendmail`
for email delivery, `logger` for syslog tagging.

### Alert Mechanisms

- **Email:** Scripts use `sendmail` (typically backed by `msmtp`). Each script
  has `ALERT_EMAIL` or `REPORT_EMAIL` env vars. Subject lines are prefixed
  `[Besedy]`.
- **Syslog/journald:** All scripts pipe output through `logger -t <tag>`.
- **Exit codes:** `backup-health-check.sh` and `weekly-report.sh` exit non-zero
  on failure, suitable for cron failure alerting.

### Script Details

**`audit-check.sh`** -- Queries `audit_log` and `users` for the last 24h.
Checks `LOGIN_FAILED` count (threshold default 5), `ACCESS_DENIED` count
(threshold default 10), superadmin count, admin role changes. Emails only on
anomalies.

**`weekly-report.sh`** -- Broad operator summary for the last seven days:
logins, active users, audio activity, MCP tool calls by tool/user/OAuth client,
admin actions, security events, local DB dump health, and combined host snapshot
coverage across the generic project snapshot root plus the Besedy-specific extra
snapshot root. Calls
`backup-health-check.sh` and `host-backup-health-check.sh` internally
(suppressed email) to embed backup status. Sends every run when `REPORT_EMAIL`
is set.

**`backup-health-check.sh`** -- Verifies: backup dir exists, latest
`besedy_YYYYMMDD_HHMMSS.sql.gz` exists and is fresh (default `MAX_AGE_HOURS=30`),
gzip size above minimum, gzip integrity valid, decompressed SQL above minimum and
contains expected marker, backup container running. Emails only on failure.

**`host-backup-health-check.sh`** -- Verifies the latest snapshots under the
generic `rsnapshot` root and the Besedy-specific `rsnapshot_besedy_extra` root
are fresh, contain the required paths, and have recent successful remote syncs.
Also verifies that the extra snapshot includes the DB dump directory with at
least one `besedy_YYYYMMDD_HHMMSS.sql.gz` file. Emails only on failure.

**`security-update-check.sh`** -- Runs `npm audit` and Trivy CVE scan against
the production image, checks base-image freshness (default
`BASE_IMAGE_MAX_AGE_DAYS=30`). Requires `jq`. Emails every run with
action-needed or all-clear subject.

> **Prerequisite — `ops.env`.** `backup-health-check.sh`,
> `host-backup-health-check.sh`, and `weekly-report.sh` read their filesystem
> paths (`BACKUP_DIR`, `PROJECT_SNAPSHOT_ROOT`, `EXTRA_SNAPSHOT_ROOT`,
> `PROJECT_LOG_FILE`, `EXTRA_LOG_FILE`) from an ops env file and **exit with an
> error if any is unset**. Copy `web/setup/backup/ops.env.example` to
> `~/.config/lukleh/besedy/ops.env` (or point `BESEDY_OPS_ENV` at it) and fill in
> the real paths before scheduling the cron jobs below.

### Host Crontab Form

```cron
0 6 * * *   ALERT_EMAIL="..."  BESEDY_COMPOSE_DIR=".../web" .../web/scripts/audit-check.sh          2>&1 | logger -t besedy-audit
30 6 * * 0  REPORT_EMAIL="..." BESEDY_COMPOSE_DIR=".../web" .../web/scripts/weekly-report.sh         2>&1 | logger -t besedy-weekly
45 6 * * *  ALERT_EMAIL="..."  BESEDY_COMPOSE_DIR=".../web" .../web/scripts/backup-health-check.sh   2>&1 | logger -t besedy-backup
5 7 * * *   ALERT_EMAIL="..."  BESEDY_COMPOSE_DIR=".../web" .../web/scripts/host-backup-health-check.sh 2>&1 | logger -t besedy-host-backup
0 7 1 * *   REPORT_EMAIL="..." BESEDY_COMPOSE_DIR=".../web" .../web/scripts/security-update-check.sh 2>&1 | logger -t besedy-security
```

### Manual Runs

Set `ALERT_EMAIL=""` or `REPORT_EMAIL=""` and `BESEDY_COMPOSE_DIR` to run any
script without sending email. Output goes to stdout.

---

## Backups

### Automatic Backups

The `backup` compose service creates daily `besedy_YYYYMMDD_HHMMSS.sql.gz` files
and retains seven days. Files land in the host path configured by `BACKUP_DIR`.

Host-side rsnapshot coverage is intentionally split:

- **Generic project root:** `/mnt/data/<user>/Backups/rsnapshot`
  - backs up `/home/<user>/projects`
  - includes `projects/besedy`, `projects/besedy_data`, `projects/besedy_posters`, and `projects/besedy_sources`
- **Besedy extra root:** `/mnt/data/<user>/Backups/rsnapshot_besedy_extra`
  - backs up non-project Besedy paths via [web/setup/backup/besedy-extra.paths.example](../../web/setup/backup/besedy-extra.paths.example) (copy to the gitignored `besedy-extra.paths`)
  - includes `audio/besedy_audio`, `audio/original`, `state/db_dumps`, `config/lukleh_besedy`, and `state/web_logs`

Both roots are synced off-host by `/home/<user>/projects/back_up.sh`.

Example host crontab entries for the Besedy extra snapshot root:

```cron
0 15 * * *   SNAPSHOT_MAP_FILE=".../web/setup/backup/besedy-extra.paths" SNAPSHOT_ROOT="/mnt/data/<user>/Backups/rsnapshot_besedy_extra" RSNAPSHOT_CONFIG="/home/<user>/.config/rsnapshot_besedy_extra.conf" LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.log" DETAIL_LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.detail.log" LOCK_FILE="/tmp/besedy_extra_rsnapshot.lock" RSNAPSHOT_LOCK_FILE="/tmp/besedy_extra_rsnapshot.pid" SYNC_TARGET="<backup-user>@<backup-host>::LinuxBackups/rsnapshot_besedy_extra/" ALERT_EMAIL="..." /home/<user>/projects/back_up.sh daily
10 15 * * 0  SNAPSHOT_MAP_FILE=".../web/setup/backup/besedy-extra.paths" SNAPSHOT_ROOT="/mnt/data/<user>/Backups/rsnapshot_besedy_extra" RSNAPSHOT_CONFIG="/home/<user>/.config/rsnapshot_besedy_extra.conf" LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.log" DETAIL_LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.detail.log" LOCK_FILE="/tmp/besedy_extra_rsnapshot.lock" RSNAPSHOT_LOCK_FILE="/tmp/besedy_extra_rsnapshot.pid" SYNC_TARGET="<backup-user>@<backup-host>::LinuxBackups/rsnapshot_besedy_extra/" ALERT_EMAIL="..." /home/<user>/projects/back_up.sh weekly
20 15 1 * *  SNAPSHOT_MAP_FILE=".../web/setup/backup/besedy-extra.paths" SNAPSHOT_ROOT="/mnt/data/<user>/Backups/rsnapshot_besedy_extra" RSNAPSHOT_CONFIG="/home/<user>/.config/rsnapshot_besedy_extra.conf" LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.log" DETAIL_LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.detail.log" LOCK_FILE="/tmp/besedy_extra_rsnapshot.lock" RSNAPSHOT_LOCK_FILE="/tmp/besedy_extra_rsnapshot.pid" SYNC_TARGET="<backup-user>@<backup-host>::LinuxBackups/rsnapshot_besedy_extra/" ALERT_EMAIL="..." /home/<user>/projects/back_up.sh monthly
30 15 1 1 *  SNAPSHOT_MAP_FILE=".../web/setup/backup/besedy-extra.paths" SNAPSHOT_ROOT="/mnt/data/<user>/Backups/rsnapshot_besedy_extra" RSNAPSHOT_CONFIG="/home/<user>/.config/rsnapshot_besedy_extra.conf" LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.log" DETAIL_LOG_FILE="/home/<user>/logs/besedy_extra_rsnapshot.detail.log" LOCK_FILE="/tmp/besedy_extra_rsnapshot.lock" RSNAPSHOT_LOCK_FILE="/tmp/besedy_extra_rsnapshot.pid" SYNC_TARGET="<backup-user>@<backup-host>::LinuxBackups/rsnapshot_besedy_extra/" ALERT_EMAIL="..." /home/<user>/projects/back_up.sh yearly
```

### Backup Verification

`backup-health-check.sh` (daily at 06:45) validates freshness, file integrity,
minimum sizes, SQL content markers, and backup container status. Failures trigger
an alert email.

`host-backup-health-check.sh` (daily at 07:05) validates Besedy coverage across
both rsnapshot roots, including the extra non-project paths and recent remote
sync success.

### Restore Procedure

```bash
cd web
bash ../scripts/run_web_compose.sh production stop web
gunzip -c /path/to/backup.sql.gz | \
  bash ../scripts/run_web_compose.sh production \
  exec -T db psql -U besedy -d besedy
bash ../scripts/run_web_compose.sh production start web
```

After restore, verify with `just prod-status` and
`curl -s https://besedy.org/api/version | jq`.

---

## Troubleshooting

**Migration fails:**
Check `MIGRATE_PASSWORD` matches between env file and DB. Ensure DB container is
healthy via `just prod-status`.

**Migration fails with "permission denied to create extension":**
The `besedy_migrator` role cannot create extensions. Create the extension as
superuser (`docker exec besedy-production-db psql -U besedy -d besedy -c 'CREATE EXTENSION IF NOT EXISTS vector;'`),
then resolve the failed migration with `npx prisma migrate resolve --rolled-back <name>`,
and rerun `just prod-migrate`.

**OAuth callback error (index corruption):**
If OAuth fails with `P2025` after unclean DB container shutdown, rebuild indexes:
`docker exec besedy-production-db psql -U besedy -d besedy -c "REINDEX DATABASE besedy;"`,
then `just prod-restart`. Prevention: always scope `docker compose up` to specific
services; never run unscoped `docker compose up -d` in production.

**OAuth callback error (config):**
Verify `AUTH_URL` matches domain exactly (including www). Check callback URLs in
Google Cloud Console.

**Audio not playing:**
Verify `AUDIO_DIR` path, mount permissions (container UID 1001), and that files
are under the mounted path.

**Logs:**
`just prod-logs` for web/db container logs. `sudo journalctl -u cloudflared -f`
for tunnel logs. `tail -F "${WEB_LOGS_DIR}/web-$(date +%F).log"` for persisted
daily web logs.
