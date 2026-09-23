# Web Operations

> **Last Updated:** 2026-09-19

Operational reference for deploying, monitoring, and running the Besedy web app.
For security hardening details see `docs/web/security.md`.
For shared repo workflow and justfile commands see `AGENTS.md`.

---

## Environments

| Environment | Web Port | DB Port | Preferred Command | Compose Overlay                                                                  |
| ----------- | -------- | ------- | ----------------- | -------------------------------------------------------------------------------- |
| Development | 3001     | 5433    | `just dev-up`     | `docker-compose.dev.yml` + `mock-oauth` profile                                  |
| Test (E2E)  | 3002     | 5434    | `just test-up`    | `docker-compose.secure.yml` (production-style)                                   |
| Production  | 3000     | 5432    | `just prod-up`    | `docker-compose.secure.yml` + `docker-compose.production.yml` + `backup` profile |

All three stacks can run simultaneously -- they use separate ports, volumes, and
container name prefixes (`besedy-development-*`, `besedy-test-*`,
`besedy-production-*`).

Always use the `just` recipes or `scripts/run_web_compose.sh`. The wrapper clears
unrelated shell state, fixes the Compose identity independently from runtime
`APP_ENV`, and validates the fully rendered configuration before Docker can
create, replace, stop, or remove resources.

---

## Development Setup

First run from a fresh clone:

```bash
mkdir -p ~/.config/lukleh/besedy
cp web/.env.dev.example ~/.config/lukleh/besedy/web.env.dev
# edit: AUTH_SECRET, VAPID keys (npx web-push generate-vapid-keys), and the data
# directories (TEXT_DATA_DIR etc. -- the text directory holds catalogs/ and
# transcripts/ written by the catalog CLI)
just dev-up
just dev-migrate   # the dev entrypoint does not migrate
just dev-seed      # superadmin/admin plus pending admissions for mock OAuth users
```

Later runs only need `just dev-up`; run `just dev-migrate` again after pulling
new migrations.

- Web: `http://localhost:3001`, DB: `localhost:5433`
- Uses mock OAuth -- no real Google credentials needed.
- pgAdmin available via `just dev-up-tools` at `http://localhost:5050`.
- Adding a catalog under **Admin -> Catalogs** syncs its CSVs into the
  database. The dev server skips the startup catalog sync, so after a catalog's
  CSVs change (for example after `just catalog add`), open its
  **Catalog Settings** and press **Sync Catalog**.

Useful follow-ups: `just web-check`, `just dev-logs`, `just dev-down`.

The dev web container runs as the invoking user, and the compose wrapper
creates missing dev/test mount directories as that user, so nothing in the
checkout or the XDG state and cache homes becomes root-owned. A checkout used
with an older dev container, which ran as root, may still hold root-owned files
that the dev server can no longer replace. Reclaim only the root-owned entries
once (not the whole state home: production logs there belong to UID 1001), then
rebuild rather than restart: a plain `dev-up` recreates the container but carries
over its old, root-owned `node_modules` volume, while `dev-rebuild` renews it.

```bash
sudo find web ~/.cache/lukleh/besedy/web ~/.local/state/lukleh/besedy/web/logs/dev \
  -user root -exec chown "$(id -u):$(id -g)" {} +
just dev-rebuild
```

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

### First Deployment on a New Host

`just prod-deploy` also performs the first deployment; these are the one-time
steps before it. Paths below use the default config home
(`~/.config/lukleh/besedy`).

1. **Host tools:** Docker Engine with Compose v2 and BuildKit, `just`, `uv`,
   `jq`, `git`, and Node.js 24 with npm. The deploy runs Prisma migrations and
   the web checks on the host, so install the web dependencies once per
   checkout:

   ```bash
   (cd web && npm ci)
   ```

2. **Config files** (all outside the checkout):

   ```bash
   mkdir -p ~/.config/lukleh/besedy
   cp web/.env.prod.example ~/.config/lukleh/besedy/web.env.prod
   cp web/besedy.container.toml.example ~/.config/lukleh/besedy/besedy.container.toml
   chmod 644 ~/.config/lukleh/besedy/besedy.container.toml
   cp jobs-service/.env.prod.example ~/.config/lukleh/besedy/jobs.env.prod
   ```

   Fill in `web.env.prod` per the preflight checklist below, set
   `superadmin_email` in `besedy.container.toml`, and set
   `BESEDY_JOB_SERVICE_SECRET` in `jobs.env.prod` to the web value (the
   production template ships it empty on purpose).
   `prod-build` reads `jobs.env.prod` even for a web-only deploy so a custom
   `BESEDY_JOBS_IMAGE` is honored.

3. **Host directories:** create every data directory named in `web.env.prod`.
   `WEB_LOGS_DIR` must be writable by container UID 1001. Prepare `ARTWORK_DIR`
   and `UPLOADS_DIR` with group `UPLOADS_GID` and mode `2770`, and make
   `BACKUP_DIR` owned by `BACKUP_UID:BACKUP_GID`. Keep the host CLI's
   `[paths].audio_artifacts_dir` outside the checkout: the production build
   refuses a dirty worktree.

4. **Database volume:** `docker volume create besedy_production_postgres`
   (see below).

5. **Deploy and verify:**

   ```bash
   just prod-deploy
   curl -s http://localhost:3000/api/health
   curl -s http://localhost:3000/api/version | jq
   ```

   On a fresh host `prod-apply` starts the database, backs up the empty
   database, applies every migration, and then starts web and the scheduled
   backup.

Deep Search, recording ingest, and the Cloudflare Tunnel are set up separately
(see [Deep Search Production Runtime](#deep-search-production-runtime),
[recording-ingest.md](recording-ingest.md), and
[Cloudflare Tunnel](#cloudflare-tunnel)).

### Deploy Preflight Checklist

**Resolved production env file** (`BESEDY_WEB_ENV_PROD` or `~/.config/lukleh/besedy/web.env.prod`):

- [ ] `POSTGRES_PASSWORD`, `MIGRATE_PASSWORD`, `APP_PASSWORD`
- [ ] `DATABASE_URL` using least-privilege app user
- [ ] `AUTH_SECRET`
- [ ] `AUTH_URL` (must match domain and OAuth redirect URI)
- [ ] `NEXT_PUBLIC_APP_URL` matches `AUTH_URL`
- [ ] `TEXT_DATA_DIR`, `ARTWORK_DIR`, `SOURCES_DIR`, `UPLOADS_DIR`, `UPLOADS_GID`
- [ ] `AUDIO_DIR`, `ORIGINAL_AUDIO_DIR`
      (production refuses to render the Compose configuration if any data
      directory above is unset; there is no fixtures fallback outside dev/test)
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
- [ ] Production jobs env file exists (`BESEDY_JOBS_ENV_PROD` or `~/.config/lukleh/besedy/jobs.env.prod`); `prod-build` reads it

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
- [ ] `just test-up && just test-rebuild`, then
      `cd web && npm run test:e2e:smoke` for production smoke coverage
- [ ] `just mcp-smoke` for authenticated MCP coverage in its isolated fixture stack
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

`prod-deploy` builds and checks the new image while the old service is still
running. It then stops `web` and the scheduled backup service, creates and
validates an immediate database backup, applies migrations, and starts the
already-built image plus scheduled backups. The maintenance window is
deliberate: neither old nor new code writes while the schema is between
versions, and a scheduled `pg_dump` cannot hold locks across the migration. If
backup or migration fails, the recipe exits with `web` and scheduled backups
stopped; inspect the error and restore or retry before starting them again.

Production builds retain immutable `besedy-web:<full-commit>` images in addition
to the mutable deployment tag. When a jobs image already exists, they also
snapshot it as `besedy-jobs:<full-commit>`; a coordinated build replaces that
snapshot with the newly built jobs image. A fresh host without a jobs image
prints a warning instead of blocking the web build. On that host, the
coordinated recipe builds and retains the jobs image before downtime; a web-only
release has no coordinated rollback until a jobs image exists. This keeps normal
web-only and coordinated releases rollback-safe without rebuilding from another
checkout. `prod-apply`
reads the web image's source-revision label and refuses to begin downtime unless
it exactly matches the current checkout. The image checks load the same
production web and jobs env files as Compose, so custom `BESEDY_WEB_IMAGE` and
`BESEDY_JOBS_IMAGE` values are checked and retained rather than silently falling
back to the default tags.

The start is scoped to the `web` service and does not recreate the database
container (which can corrupt indexes). The `prod-migrate` step also grants the
app access to newly migrated tables and re-applies the `audit_log` DELETE
revoke. `just prod-backup` is available separately when an immediate verified
backup is needed outside a deployment.

For a release that changes the web/jobs contract, use
`just prod-deploy-with-jobs`. It builds both images before downtime, stops the
jobs API and worker, performs the web backup and migration, then starts web,
jobs, and refreshes the Prefect deployment. Production profiles using
`model-chatgpt-*` must use `just prod-deploy-with-jobs-codex` so the narrowly
scoped Codex auth mount is retained. The coordinated recipes check the production
Prefect deployment before downtime, then stop new submissions and check again
before stopping the worker. If a run is queued or active, deployment refuses to
continue; wait for it to finish or cancel it explicitly. If a run races the
first check, the unchanged web and jobs API containers are restarted without
migrating.

### Event artwork cutover

The production cutover completed on 2026-09-19. The fixed recording-scoped
files were backed up, reviewed, and imported as three unpublished event
artwork candidates. Candidate/file hashes matched, the publication table
remained empty, and the temporary legacy inventory/import commands were then
retired. The obsolete `poster_status` table was already absent through
migration `20260218100000_drop_poster_status`. The concept was later renamed
from "poster" to "artwork"; see [ADR 0011](../adr/0011-poster-to-artwork-rename.md)
for the schema, storage, and CLI rename and its own migration
(`20260920160000_rename_event_poster_to_artwork`), which ran after this
cutover.

#### ADR 0011 rename cutover

The poster-to-artwork rename is a hard cut: nothing reads `POSTERS_DIR`,
`posters_dir`, or the `posters_<catalogId>` directory layout after it. The
storage rename, the config rename, and the database migration must all land in
one downtime window, in this order. Filesystem first, because it has no
transactional rollback: a failure there aborts before any schema change.

1. Stop the web container and scheduled backup so nothing writes artwork while
   paths move, leaving the database up for the migration:
   `cd web && bash ../scripts/run_web_compose.sh production stop web backup`
   (the same step `just prod-apply` performs; `just prod-down` would also stop
   the database).
2. Rename the host directory and update the operator files outside the checkout:
   - `mv ~/projects/besedy_posters ~/projects/besedy_artwork`
   - in the production env file (`CONFIG_FILE`'s sibling `web.env.prod`):
     replace `POSTERS_DIR=...` with `ARTWORK_DIR=/home/<user>/projects/besedy_artwork`
   - in the container TOML that `CONFIG_FILE` points at: replace
     `posters_dir = "/data/posters"` with `artwork_dir = "/data/artwork"`
3. Rename the per-catalog directories inside the storage root:
   `just artwork-storage --prod --dry-run`, review, then
   `just artwork-storage --prod --yes`. The script refuses to touch a root
   where a prefixed entry is not a plain directory or where both names exist.
4. `just prod-build`, then `just prod-apply`, which takes the pre-migration
   backup, runs migration `20260920160000_rename_event_poster_to_artwork`, and
   restarts web with the renamed mount.
5. `just artwork-storage --prod --verify` to confirm every
   `catalog_event_artwork` row's files exist at the renamed paths.

Rolling back before step 4 is `just artwork-storage --prod --reverse --yes`
plus restoring the two operator files and the host directory name. After step
4 the database rename has committed; use the pre-migration backup that
`just prod-apply` takes.

Use the retained artwork CLI for normal event artwork operations:

```bash
just artwork list --catalog <catalog-id> --event <event-id> --actor <email-or-id> --prod
just artwork create --catalog <catalog-id> --event <event-id> --actor <email-or-id> \
  --square <file> --landscape <file> --label <text> --prod --yes
just artwork publish --catalog <catalog-id> --event <event-id> --actor <email-or-id> \
  --artwork <artwork-id> --prod --yes
just artwork unpublish --catalog <catalog-id> --event <event-id> --actor <email-or-id> --prod --yes
just artwork delete --catalog <catalog-id> --event <event-id> --actor <email-or-id> \
  --artwork <artwork-id> --prod --yes
```

`ARTWORK_DIR` must belong to the shared `UPLOADS_GID` group and have mode
`2770`. Artwork writes preserve that shared group on descendant directories and
use group-readable files so host-run CLI imports and the web container can read
each other's candidates.

For host-run commands, the CLI rewrites the container database hostname to the
published `DB_PORT` binding from the selected environment file. Production
mutations require the explicit `--yes` confirmation.

To verify that no artwork is currently published:

```sql
SELECT count(*) AS published_artwork
  FROM catalog_event_artwork_publication;
```

The result must be zero when the deployment policy requires every artwork to
remain unpublished.

### Permissions rework rollout

Deploy the lookup ownership change separately from the role cutover:

1. Merge through migration `20260916090000_scope_metadata_lookups_to_catalog`
   together with the lookup-route changes that write `workflow_group_id`, then
   run `just prod-deploy`. Do not apply this migration while older lookup code
   can create rows without a catalog.
2. Verify every lookup has a catalog and every reference points to a lookup in
   the same catalog:

   ```sql
   SELECT 'recorders' AS kind, count(*) FROM recorders WHERE workflow_group_id IS NULL
   UNION ALL SELECT 'locations', count(*) FROM locations WHERE workflow_group_id IS NULL
   UNION ALL SELECT 'albums', count(*) FROM albums WHERE workflow_group_id IS NULL;

   SELECT count(*) AS mismatched_lookup_references
   FROM (
     SELECT 1 FROM audio_metadata m JOIN recorders r ON r.id = m.recorder_id
       WHERE r.workflow_group_id <> m.workflow_group_id
     UNION ALL
     SELECT 1 FROM audio_metadata m JOIN locations l ON l.id = m.location_id
       WHERE l.workflow_group_id <> m.workflow_group_id
     UNION ALL
     SELECT 1 FROM audio_metadata m JOIN albums a ON a.id = m.album_id
       WHERE a.workflow_group_id <> m.workflow_group_id
     UNION ALL
     SELECT 1 FROM catalog_event e JOIN locations l ON l.id = e.location_id
       WHERE l.workflow_group_id <> e.workflow_group_id
   ) mismatches;
   ```

   Every count must be zero before continuing.

3. Merge the remaining permission stack and deploy it as one coordinated
   web/jobs maintenance release with `just prod-deploy-with-jobs` (or the
   `-codex` variant). This applies the additive role columns and then assigns
   every active and pending grant a role while no old worker is running.
4. Verify the role backfill before accepting traffic as healthy:

   ```sql
   SELECT count(*) AS grants_without_role FROM catalog_access WHERE role IS NULL;
   SELECT count(*) AS pending_without_role FROM pending_catalog_grant WHERE role IS NULL;
   SELECT access_level, role, extra_permissions, count(*)
     FROM catalog_access
    GROUP BY access_level, role, extra_permissions
    ORDER BY access_level, role;
   ```

   The first two counts must be zero. Compare the grouped mapping with the
   preflight snapshot: `LISTENER -> listener`, `VIEWER/MEMBER -> reader`,
   `EDITOR -> curator`, and `OWNER -> host` plus `download_transcripts`. This
   check must run before step 5: once `access_level` is dropped, only the two
   `role IS NULL` counts remain meaningful.
5. Once the role-native web release (#151) is live and nothing reads
   `access_level`, deploy `20260921170000_drop_legacy_access_level` with a
   plain `just prod-deploy`. It refuses to run while any grant lacks a role,
   then makes `role` NOT NULL and drops `access_level` and the `AccessLevel`
   enum. There is no reverse migration, and the previous image alone cannot
   run against the migrated schema: its claim path still selects
   `access_level`, so first sign-in for invited users would fail. Roll back
   with the guarded `prod-rollback` recipe (see Rollback below), which
   restores the retained pre-migration backup together with the image.

Each maintenance run creates its own verified pre-migration backup below
`BACKUP_DIR/deploy/`. These backups are deliberately excluded from the rotating
seven daily files and remain until an operator removes them. If a post-migration
verification fails, use the guarded rollback recipe described below; it
preserves the failed-state database, restores that run's backup, and restarts
the retained previous images. Do not attempt an ad-hoc reverse migration.

**Migrations run before the new container starts, and that order matters.** The
new image knows about columns the old schema lacks, and Prisma asks for every
scalar of a model unless a query names a `select`, so starting it first would
leave it serving against a schema it does not match until the restart. Migrating
first has the old container meet the new schema instead, which additive
migrations do not disturb. `prod-migrate` runs from the host against the `db`
container, so it needs nothing from `web`.

A migration that removes or narrows something the running code still uses breaks
that reasoning in the other direction: no ordering saves it, because one of the
two must meet a schema it does not match. Besedy is not a high-availability
deployment, so the answer there is to stop `web`, migrate, and start it again,
rather than to stage the change across two releases.

**Version tracking:** The build keeps `GIT_COMMIT` for deployment diagnostics
and derives `WEB_VERSION` from an allowlist of production web inputs plus the
browser-visible build configuration. Root-only, jobs/Python, web test, and web
documentation commits therefore do not replace the service worker. Dirty web
checkouts are still rejected to keep production builds reproducible.
Both identifiers are visible at `GET /api/version`; the admin sidebar continues
to display the source commit. Update lifecycle telemetry is available under
**Admin → Web Updates** and is retained for 30 days.

**Fresh database caveat:** Older migrations create `vector` columns before later
migrations remove them, and the migrator role cannot create the non-trusted
`vector` extension. `web/init-db-users.sh` therefore creates it as superuser when a
new production volume is initialized, so a brand-new DB migrates without manual
steps. A volume initialized before that script created the extension needs it
installed once before its first migration:

```bash
docker exec besedy-production-db psql -U besedy -d besedy -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

Existing databases that already passed that point need nothing.

**Required one-time cleanup for hosts with the retired LAN egress control:**

Removing the repository files does not disable a unit or delete firewall rules
previously installed on a host. Follow
[Removing an Earlier Host Installation](egress-control-retirement.md#removing-an-earlier-host-installation)
during a maintenance window. Do not consider the retirement complete until
these checks succeed:

```bash
set -euo pipefail
egress_units=$(systemctl list-unit-files --no-legend 'besedy-egress*')
test -z "$egress_units"
test ! -e /usr/local/bin/iptables-egress.sh
docker_user_rules=$(sudo iptables -S DOCKER-USER)
if grep -Fq besedy-egress <<<"$docker_user_rules"; then
  echo "leftover besedy-egress rules in DOCKER-USER" >&2
  exit 1
fi
if sudo iptables -S BESEDY-EGRESS >/dev/null 2>&1; then
  echo "leftover BESEDY-EGRESS chain" >&2
  exit 1
fi
```

The last check also covers hosts where the unmerged dynamic reconciler was
tested. Run this cleanup once per affected host; it is not part of routine
releases.

**First-deployment extras** (run once, not on every release):

1. Install monitoring cron jobs (see Monitoring section below).

### Post-Deploy Verification

- [ ] `just prod-status` shows healthy services
- [ ] Site loads at production URL, Google OAuth sign-in works
- [ ] First sign-in with `superadmin_email` gets admin role
- [ ] Catalog upload and audio streaming work
- [ ] `just prod-monitor` (session health -- see below)
- [ ] Backups appearing in `BACKUP_DIR`
- [ ] Daily logs appearing in `WEB_LOGS_DIR`

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

Every production build keeps the web image and the jobs image paired with it
tagged with the release's full source commit, and every maintenance deployment
writes a verified backup under
`BACKUP_DIR/deploy/`. For a coordinated web/jobs rollback, select the previous
known-good commit and the backup created immediately before the failed release:

```bash
previous_commit=<full-40-character-commit>
backup=deploy/besedy_deploy_<failed-commit>_<timestamp>.sql.gz
CONFIRM_PROD_ROLLBACK="$previous_commit:$backup" \
  just prod-rollback "$previous_commit" "$backup"
```

For a `model-chatgpt-*` production profile, retain the narrowly scoped Codex
credential mount during rollback:

```bash
CONFIRM_PROD_ROLLBACK="$previous_commit:$backup" \
  just prod-rollback-codex "$previous_commit" "$backup"
```

The recipe verifies both retained images and that Prefect is idle, stops all
writers and the scheduled backup service, creates another retained backup of
the failed state, validates and restores the selected archive into a fresh
database, then starts the exact previous web/jobs images, restarts scheduled
backups, and re-registers that jobs deployment. A missing image, active job, bad
archive, or mismatched confirmation stops before the database is replaced.

For a database-only restore, stop web, the scheduled backup service, the jobs
API, and the worker first, then repeat the exact archive path in the
confirmation:

```bash
backup=deploy/besedy_deploy_<commit>_<timestamp>.sql.gz
CONFIRM_PROD_RESTORE="$backup" just prod-restore "$backup"
```

After either path, verify `just prod-status`, `just jobs-prod-status`, the public
version endpoint, authentication, and the permission backfill queries above.
Remove old `BACKUP_DIR/deploy/` archives and `besedy-web:<commit>` /
`besedy-jobs:<commit>` images only after the release is accepted.

---

## Deep Search Production Runtime

Deep Search runs _outside_ the Next.js app: a shared Prefect control plane plus a
per-environment jobs runtime (jobs API + worker), all joined to the
`besedy-internal` Docker network alongside production web. See
[docker-container-topology.md](docker-container-topology.md) for the full
container/network map. **Prefect is shared across environments; the jobs runtime
is not** -- dev and prod each run their own, so a production job never routes
through the development runtime.

### Deploy Order

1. **Web + jobs contract changes** -- use `just prod-deploy-with-jobs` (or the
   `-codex` variant for `model-chatgpt-*`). See Production Deploy above. This
   coordinated path is required whenever a worker request/response contract or
   its authorization context changes; do not migrate web while an old worker
   can still issue writes or internal requests.
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
2. **Initial shared Prefect + production runtime setup:**

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

## Recording Ingest (Host Worker)

Admin uploads on `/admin/ingest` are processed by a Prefect worker running on
the host (not in the hardened jobs containers). Full runbook:
[recording-ingest.md](recording-ingest.md).

Deploy additions on top of the Deep Search steps above:

1. Web env file: set `UPLOADS_DIR` and `UPLOADS_GID`, prepare that directory as
   the shared group with mode `2770`, add the worker user to the group, and add
   `<host uploads dir>=/data/uploads` to `BESEDY_PATH_MAPPINGS`; host
   `besedy.toml`: set `[paths].uploads_dir` to the same host directory.
2. `just prod-deploy` (includes the `recording_intake` migration) and
   `just jobs-prod-rebuild && just jobs-prod-deploy` (registers the
   `besedy-ingest-prod` pool and `ingest_recording_flow/ingest-prod`).
3. Install and start the host worker unit from
   `jobs-service/host-worker/besedy-ingest-worker.service` with
   `~/.config/lukleh/besedy/ingest-worker.env` filled in
   (`BESEDY_INTERNAL_BASE_URL=http://127.0.0.1:3000`, the production
   `BESEDY_JOB_SERVICE_SECRET`, `PREFECT_INGEST_WORK_POOL=besedy-ingest-prod`).
4. Verify: `systemctl --user status besedy-ingest-worker`, the pool shows a
   healthy worker in the Prefect UI, then upload a short recording and watch it
   reach `SUCCEEDED` with a hash link.

Cloudflare limits proxied request bodies to 100 MB; uploads are chunked at
`INGEST_CHUNK_BYTES` (default 50 MB) so do not raise that above the limit.

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

All monitoring scripts live in `web/scripts/`. Host backup setup assets live in
`web/setup/backup/`.

### Script Inventory

| Script                        | Schedule          | Alerts When                                                           | Logger Tag             |
| ----------------------------- | ----------------- | --------------------------------------------------------------------- | ---------------------- |
| `mcp-usage-retention.sh`      | Daily 05:50       | Failure; otherwise rolls up and prunes raw MCP telemetry              | `besedy-mcp-retention` |
| `audit-check.sh`              | Daily 06:00       | Failed logins or access denials exceed thresholds; admin role changes | `besedy-audit`         |
| `weekly-report.sh`            | Weekly Sun 06:30  | Every run (full 7-day activity summary)                               | `besedy-weekly`        |
| `backup-health-check.sh`      | Daily 06:45       | Any backup health check fails                                         | `besedy-backup`        |
| `host-backup-health-check.sh` | Daily 07:05       | Snapshot coverage fails; separate warning when remote sync trends slow | `besedy-host-backup`   |
| `security-update-check.sh`    | Monthly 1st 07:00 | Every run (subject varies by findings)                                | `besedy-security`      |

All scripts require Docker access, `jq`, production compose files, and the
resolved production env file via `scripts/resolve_web_env_file.sh production`.
Reporting and alert scripts additionally require `sendmail`; scheduled commands
use `logger` for syslog tagging. Database-backed scripts fail closed and alert
instead of reporting zero values when the container or a query is unavailable.

### Alert Mechanisms

- **Email:** Scripts use `sendmail` (typically backed by `msmtp`). Each script
  has `ALERT_EMAIL` or `REPORT_EMAIL` env vars. Subject lines are prefixed
  `[Besedy]`.
- **Syslog/journald:** All scripts pipe output through `logger -t <tag>`.
- **Exit codes:** `backup-health-check.sh` and `weekly-report.sh` exit non-zero
  on failure, suitable for cron failure alerting. `host-backup-health-check.sh`
  exits 1 on a coverage failure and 3 when only a trend warning fired.

### Script Details

**`audit-check.sh`** -- Queries `audit_log` and `users` for the last 24h.
Checks `LOGIN_FAILED` count (threshold default 5), `ACCESS_DENIED` count
(threshold default 10), superadmin count, admin role changes. Emails only on
anomalies.

**`mcp-usage-retention.sh`** -- Aggregates raw MCP invocations older than 180
days into privacy-safe daily rows and deletes the raw rows in the same database
transaction. It also deletes daily aggregates older than 400 days. Set
`MCP_RAW_RETENTION_DAYS` to change the raw retention window and
`MCP_ROLLUP_RETENTION_DAYS` to change aggregate retention; aggregate retention
must be at least 366 days so 12-month reports remain complete.

**`weekly-report.sh`** -- Broad operator summary for the last seven days:
logins, active users, audio activity, MCP tool calls by tool/user/OAuth client,
admin actions, security events, local DB dump health, and combined host snapshot
coverage across the generic project snapshot root plus the Besedy-specific extra
snapshot root. Calls
`backup-health-check.sh` and `host-backup-health-check.sh` internally
(suppressed email) to embed backup status, plus the read-only
`backup-growth-report.sh` (top-level directories of the project snapshot that
grew most by file count over the retained dailies) and `worktree-report.sh`
(linked git worktrees and which ones look safe to remove); each helper is cut
off after `HELPER_REPORT_TIMEOUT_SECONDS` (default 600) so a cold snapshot
filesystem cannot stall the report. Sends every run when `REPORT_EMAIL` is set.

**`backup-health-check.sh`** -- Verifies: backup dir exists, latest
`besedy_YYYYMMDD_HHMMSS.sql.gz` exists and is fresh (default `MAX_AGE_HOURS=30`),
gzip size above minimum, gzip integrity valid, decompressed SQL above minimum and
contains expected marker, backup container running. Emails only on failure.

**`host-backup-health-check.sh`** -- Verifies the latest snapshots under the
generic `rsnapshot` root and the Besedy-specific `rsnapshot_besedy_extra` root
are fresh, contain the required paths, and have recent successful remote syncs.
Also verifies that the extra snapshot includes the DB dump directory with at
least one `besedy_YYYYMMDD_HHMMSS.sql.gz` file. Emails only on failure.
It also watches the remote sync trend in the same logs and sends a separate
`Host backup trend WARNING` email when the latest successful sync took longer
than `REMOTE_SYNC_MAX_DURATION_MINUTES` (default 120) or its synced file count
grew more than `REMOTE_SYNC_MAX_GROWTH_PERCENT` (default 25) against the last
successful sync at least `REMOTE_SYNC_GROWTH_WINDOW_DAYS` (default 7) earlier.
Those are the signs that preceded the September 2026 remote sync overruns.
Both checks read the newest rotated `back_up.sh` log, time a retried sync from
its first attempt, and ignore `RSYNC_DRY_RUN` runs (which also log a success
line without copying anything). A slow sync stays slow for days, so the
warning email is repeated only when the set of warning kinds changes or
`REMOTE_SYNC_WARNING_REPEAT_HOURS` (default 168) have passed since the last
one; the exit code and syslog line fire every run. The last email is recorded
in `HOST_BACKUP_STATE_FILE` (default
`~/.local/state/lukleh/besedy/host-backup-trend.state`) and forgotten once the
check is healthy again.

**`backup-growth-report.sh`** and **`worktree-report.sh`** -- On-demand,
read-only helpers (also embedded in the weekly report). The growth report
compares per-directory file counts between the oldest and newest daily project
snapshot; hard-linked files count under every directory that holds one, as
`rsync -H` syncs them. The worktree report lists every linked worktree of the
git repos under `~/projects` and marks it `REMOVABLE` only when it is clean,
unlocked, idle for `WORKTREE_MIN_IDLE_DAYS` (default 3), holds no gitignored
files beyond regenerable build/dependency trees (`git worktree remove` deletes
ignored files without `--force`), has no detached-HEAD commits missing from
every branch (a checked-out branch survives removal, so its unpushed commits
are not a reason to keep the worktree), and is not used by a Docker container
(compose working dir or bind mount) or a running process. The git and docker
checks fail closed: if git or `docker ps` cannot answer, the worktree is kept.
The process check can only see processes of the invoking user unless run as
root; run from a terminal, it says how many it skipped. A removable branch
worktree whose branch has commits on no remote branch (typically squash-merged
with the remote branch deleted) is annotated with that count, since after
removal the local branch is their only copy. It prints
`git worktree remove` commands but never runs them.

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
50 5 * * *   ALERT_EMAIL="..."  BESEDY_COMPOSE_DIR=".../web" .../web/scripts/mcp-usage-retention.sh                     2>&1 | logger -t besedy-mcp-retention
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
Maintenance deployments additionally create
`deploy/besedy_deploy_<commit>_<timestamp>.sql.gz`. The daily rotation does not
touch that subdirectory; deployment backups are removed only by an operator
after the rollback window closes.

Host-side rsnapshot coverage is intentionally split:

- **Generic project root:** `/mnt/data/<user>/Backups/rsnapshot`
  - backs up `/home/<user>/projects`
  - includes `projects/besedy`, `projects/besedy_data`, `projects/besedy_artwork`, and `projects/besedy_sources`
    (`projects/besedy_artwork` is the renamed `projects/besedy_posters`; see the
    ADR 0011 cutover steps above)
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
sync success, and warns early when the remote sync gets slow or the synced file
count jumps.

### Restore Procedure

Use a retained deployment archive and the guarded restore recipe. It requires
the web service, jobs API, and worker to already be stopped, verifies the gzip
archive before replacing the database, and requires an exact confirmation:

```bash
backup=deploy/besedy_deploy_<commit>_<timestamp>.sql.gz
CONFIRM_PROD_RESTORE="$backup" just prod-restore "$backup"
```

Start the intended image versions only after the restore succeeds. For a full
coordinated rollback, prefer `just prod-rollback` as described in the Rollback
section. Then verify service status and the public version endpoint.

---

## Troubleshooting

**Migration fails:**
Check `MIGRATE_PASSWORD` matches between env file and DB. Ensure DB container is
healthy via `just prod-status`.

**Migration fails with "permission denied to create extension":**
The `besedy_migrator` role cannot create non-trusted extensions. New volumes get
`vector` from `web/init-db-users.sh`; on an older volume, create the extension as
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
