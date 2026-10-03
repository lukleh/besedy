# Web Data Model and Database

> **Last Updated:** 2026-04-04

How the web app models and serves catalog data (PostgreSQL + CSVs), database migration safety, and key environment configuration. For core pipeline data contracts (transcript schemas, storage layout), see [../data-model.md](../data-model.md).

---

## Catalog Data Model

### CSV Source Types

Each workflow group (catalog) is identified by a timestamp ID like `20251201_143022`. Three CSV types feed the web data layer:

| Type                      | Pattern                                                           | Required |
| ------------------------- | ----------------------------------------------------------------- | -------- |
| Metadata catalog          | `audio_catalog_<id>.csv`                                          | Yes      |
| Archived catalog          | `audio_catalog_<id>_loudness_archived.csv`                        | Yes      |
| Listening variant catalog | Path stored in `workflow_variant.listening_archived_catalog_path` | No       |

Optional artifacts: `audio_catalog_<id>_duplicates.csv` (duplicates), `transcripts_<id>/` (ASR output). CSV files are ingest input only -- API endpoints never parse them directly.

### Discovery

The discovery endpoint (`/api/catalogs/discover`) scans `BESEDY_BASE_DIR` for files matching `audio_catalog_<id>.csv` that also have a matching archived catalog (`audio_catalog_<id>_loudness_archived.csv`). It returns only **unregistered** groups -- those not yet tracked in the `workflow_group` table.

### Sync Rules

CSV-to-DB sync stores a versioned SHA-256 generation fingerprint for the exact
source bytes that were parsed (`v4:sha256:<digest>`). Source snapshots are read
once per reconciliation, before the database transaction and advisory lock, so
fingerprinting and parsing cannot observe different file contents. Older
stat-based fingerprints cause a one-time refresh after upgrade. The version is
bumped when sync starts reading a column it ignored before, so every source is
rebuilt once on the first sync after that deploy, even when its bytes are
unchanged; `v4` added the AAC copy columns (#291).

| Condition                        | Effect                                                   |
| -------------------------------- | -------------------------------------------------------- |
| Fingerprint unchanged            | Source skipped                                           |
| Changed metadata or archived CSV | Rebuild `catalog_entry`                                  |
| Changed duplicates CSV           | Rebuild `catalog_duplicate`, recompute `duplicate_count` |
| Changed listening variant CSV    | Rebuild only that variant in `catalog_listening_entry`   |

Sync triggers:

- Startup reconciliation (web runtime, runs in the background after bootstrap)
- Admin endpoint: `POST /api/admin/catalog-sync`
- CLI: `npm run catalog:sync [-- --group <id>] [--force]`

`--force` bypasses fingerprint checks and rebuilds all tracked sources for the scope.

### CSV Contract With the Python Writers

The columns the sync reads from each CSV kind are listed in
`contracts/catalog-csv.json`, together with the decoded-audio hash contract
(`Hash Algorithm`). `tests/test_catalog_csv_contract.py` checks that the real
Python writers emit them, and `web/tests/unit/catalog-csv-contract.test.ts`
checks that the sync reads exactly them, so renaming a column on either side
fails a test. Change the JSON together with both sides.

A metadata row whose `Hash Algorithm` is missing or not
`pcm-s16le-16000hz-mono-sha256-v1` still syncs. The sync that parses the
changed CSV carries the count as `unrecognizedHashAlgorithmRows` in its result
and logs a warning; the catalog settings sync toast shows it when that sync was
started from the settings page. The count is not stored, so a later sync of
unchanged CSVs (`skipped`) does not repeat it.

`GET /api/health` reports the startup projection state (`ready`, `degraded`,
`running`, `disabled`, or `not-started`). By default a sync error is reported as
degraded while the last successful projection remains available. Set
`CATALOG_SYNC_REQUIRED_FOR_READINESS=true` to return HTTP 503 while the initial
projection is running or degraded. Requiring readiness while setting
`CATALOG_SYNC_STARTUP_ENABLED=false` is invalid and stops startup with a clear
configuration error.

### CatalogEntry Join Contract

`catalog_entry` is materialized by sync as a full-outer-join of the metadata and archived CSVs:

- **Join key:** `Hash` -> `audio_hash`
- **Duplicate handling:** Duplicate `Hash` in either metadata or archived CSV is a sync error
- **Actionable flag:** `is_actionable = has_archived AND has_metadata`
- **Publication:** `is_published` is admin/owner-managed, defaults to `false` for new hashes
- **Listener visibility:** `is_actionable AND is_published`
- **Duration precedence:** metadata `Duration` first, then archived `Duration`
- **Path resolution:**
  - `compressed_path` from archived `Compressed Path`
  - `compressed_aac_path` from archived `Compressed AAC Path`, the AAC-in-MP4 copy that
    `catalog archive` writes next to the Opus WebM (#291); `NULL` when the column is
    missing or blank, and the WebM is then the only file
  - `original_path` from metadata full/original path when available, otherwise archived `Original Path`

Rows missing from one source still exist in `catalog_entry` but remain non-actionable.

### WorkflowVariant Model

`WorkflowVariant` enables alternate listening sources per catalog. Each variant points to a separate archived catalog via `listeningArchivedCatalogPath`. Variant availability is tracked in `catalog_listening_entry`, synced independently from the main catalog entries; its `compressed_aac_path` comes from the variant catalog's `Compressed AAC Path` in the same way.

### Audio Source Resolution

When serving audio, the app resolves sources in priority order:

1. **Archived** (compressed) -- primary playback source
2. **Listening variant** -- alternate quality/format from a workflow variant
3. **Original** -- uncompressed source for download

Per-recording source preferences are stored in `user_preferences.settings.audioSources`.

Independently of the source, `format` picks the file: `webm` (default), the Opus
archive every recording has, or `aac`, its AAC-in-MP4 copy (`compressed_aac_path`,
#291) for browsers that cannot stream WebM. The route resolves the source first
(a variant without a row for the recording falls back to archived) and then takes
that source's AAC copy; when it has none the response is `404` rather than the
WebM, and `format=aac` with `source=original` is a `400`. `/audio/sources` lists
the `formats` each source can be served in, so clients only ask for copies that
exist.

---

## Database

Besedy uses PostgreSQL with Prisma ORM. Schema: `web/prisma/schema.prisma`. Migrations: `web/prisma/migrations/`.

### Migration Workflow

**Create a migration** (development only):

```bash
npx prisma migrate dev --name descriptive_name
```

Run from inside the web container. Commit the new migration directory.

Prisma applies pending migrations in name order, so a new migration's
timestamp must be later than every migration on `main`. If `main` gained a
later migration while your branch was open, rename your migration directory to
a current timestamp before merging. Rename it before applying it to the dev
database if you can. If the dev database already applied it, it would run the
SQL again under the new name: mark the new name applied with
`npx prisma migrate resolve --applied <new name>` and delete the old name's row
from `_prisma_migrations`. CI enforces this for directories a pull request adds
(`scripts/check_migration_names.sh`). Migrations already on `main` must not be
renamed or deleted, because production has applied them under those names; CI
fails on that too.

**Apply migrations:**

| Environment | Command                                                     |
| ----------- | ----------------------------------------------------------- |
| Development | `npx prisma migrate deploy` (inside web container)          |
| Test        | `just test-reset` (disposable E2E database on port 5434)    |
| Production  | `just prod-migrate` (uses dedicated `besedy_migrator` user) |

Production runs with least-privilege `besedy_app` for the web process; only the migrator role applies schema changes.
Development and the E2E test stack connect as the database superuser. CI's
migration job (`correction-integration` in `.github/workflows/ci.yml`) creates
both roles with `web/init-db-users.sh`, applies the migrations as
`besedy_migrator`, applies the same `besedy_app` grants as `just prod-migrate`
(including the `audit_log` DELETE revoke) and runs the correction smoke check
as `besedy_app`, so a privilege problem fails there rather than at deploy.

### Safety Rules

> **WARNING: Destructive operations can cause irreversible data loss.**
>
> The following commands must NEVER be run against development, test (non-disposable), or production databases:
>
> - `prisma db push` -- bypasses migration history, causes drift
> - `prisma migrate reset` -- drops and recreates the entire database
>
> These are acceptable ONLY in:
>
> - Disposable local experimentation (non-shared)
> - The E2E test database via `just test-reset`

> **Environment access rules:**
>
> | Environment | Allowed Operations                                              |
> | ----------- | --------------------------------------------------------------- |
> | Development | `migrate dev` (create), `migrate deploy` (apply), Prisma Studio |
> | Test (E2E)  | `test-reset` (full reset OK -- disposable)                      |
> | Production  | `migrate deploy` ONLY via `just prod-migrate`                   |

Additional constraints:

- Schema drift check: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (exit code 2 means the database and the schema differ). CI runs it on a freshly migrated database. It covers what Prisma models; triggers, views and CHECK constraints that exist only in migration SQL are outside it.
- If "relation does not exist" errors appear, run `npx prisma migrate deploy` against the target environment
- Backups: daily `besedy_YYYYMMDD_HHMMSS.sql.gz` into `BACKUP_DIR` via the backup service

### Key Tables

| Table                                | Purpose                                          |
| ------------------------------------ | ------------------------------------------------ |
| `workflow_group`, `workflow_variant` | Catalog registration and alternate audio sources |
| `catalog_entry`                      | Materialized metadata + archived join            |
| `catalog_duplicate`                  | Duplicate rows from duplicates CSV               |
| `catalog_listening_entry`            | Per-variant listening availability               |
| `catalog_sync_state`                 | Source fingerprint + status tracking             |
| `catalog_access`                     | User-to-catalog grants with access levels        |
| `audio_metadata`                     | Curated metadata per recording                   |
| `users`, `accounts`, `sessions`      | Better Auth identity/session tables              |
| `user_preferences`                   | Active catalog, theme, settings                  |
| `audit_log`                          | Security and access event log                    |

### Transcript Correction Tables

Human transcript correction ([ADR 0006](../adr/0006-transcript-correction.md))
keeps current projections and immutable history side by side. PostgreSQL is
authoritative for work in progress; the rendered artifacts are immutable files.

| Table                         | Purpose                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `transcript_workspace`        | One correction over a frozen machine source, plus its two pointers |
| `transcript_span`             | One source segment, with fixed boundaries and a current revision   |
| `transcript_span_revision`    | Immutable normalized text, chained to its predecessor              |
| `transcript_span_decision`    | Immutable approve / disapprove / withdraw by one person            |
| `transcript_span_comment`     | Optional discussion, recording the revision its author saw         |
| `transcript_publication`      | One immutable snapshot, the job that activates it, and what search reported |
| `transcript_publication_span` | The exact revision used for every span in a publication            |
| `transcript_guide_revision`   | Immutable versions of the catalog correction guide                 |

Three invariants live in the database rather than in application code, because
they have to hold against concurrent requests:

- **One live workspace per recording.** A partial unique index over
  non-archived rows, so the exceptional archive-and-recreate path keeps every
  abandoned workspace for audit. Prisma cannot express a partial index, so it is
  created in the migration and not declared in `schema.prisma`.
- **One publication in flight per workspace.** A partial unique index over
  `PENDING`, `ACTIVATING` and `ROLLING_BACK`, which is also what locks the
  workspace against writes while a snapshot is being materialized, activated
  or rolled back.
- **One decision per idempotency key.** `UNIQUE (workspace_id, actor_key,
  idempotency_key)`, keyed on the immutable actor rather than the nullable
  account reference, so a double-click or a retried request cannot record the
  same decision twice even after the account is deleted.

Span state is never stored. It is derived from the decisions bound to a span's
**current** revision, so a superseded approval cannot count and no status
column can drift from the decisions underneath it.

The two workspace pointers are deliberately separate. `reader_publication_id`
is what the reader, the ordinary download and the bulk export resolve;
`search_publication_id` is what search indexing and MCP resolve. An ordinary
unpublish clears only the first.

Neither pointer moves until the search index has caught up. A publication in
`ACTIVATING` carries `index_job_id`, the Prefect flow run asked to sync the
recording, and receives `search_source_fingerprint` and `search_source_path`
from that run's completion report; the pointers move only when the reported
path is this publication's own artifact. `search_withdrawal_job_id` plays the
same role for a withdrawal from search. The wiring is described with the
pointer file in [Data model](../data-model.md#publication-waits-for-the-index).

---

## Configuration

### Data Directories

| Variable             | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `BESEDY_BASE_DIR`    | Root directory scanned for catalog discovery |
| `TEXT_DATA_DIR`      | Catalogs and transcripts                     |
| `AUDIO_DIR`          | Streamable (compressed) audio                |
| `ORIGINAL_AUDIO_DIR` | Downloadable original audio                  |
| `ARTWORK_DIR`        | Writable artwork storage                      |
| `SOURCES_DIR`        | Writable recording sources storage           |
| `CORRECTIONS_DIR`    | Writable transcript-correction storage, shared with the host worker |

Inside the container the correction tree is `[paths].corrections_dir` of the
container toml, `/data/corrections`, which Compose binds to `CORRECTIONS_DIR`.
The default of `<text_data_dir>/corrections` only suits a host-run web app,
because the container mounts `TEXT_DATA_DIR` read-only. The host worker reads
the same tree through the host `besedy.toml`; host-run Python tooling can
override it with `BESEDY_CORRECTIONS_ROOT`.

### Path Mappings

`BESEDY_PATH_MAPPINGS` rewrites host paths found in CSV entries to container-accessible paths at runtime:

```
BESEDY_PATH_MAPPINGS=/mnt/data/audio=/data/original,/mnt/data/text=/data/text
```

Each entry is `<host_prefix>=<container_prefix>`, comma-separated, split on the first `=` (a container path may contain one). The app applies these rewrites before path validation. Rules:

- Use full path-prefix boundaries (not fragments that could match unrelated paths)
- The longest matching prefix wins, whatever the order of the entries
- Keep mappings aligned with Docker volume mounts
- `BESEDY_ALLOWED_PATHS` can extend the set of container paths that pass validation

### Other Key Variables

| Variable                           | Notes                                          |
| ---------------------------------- | ---------------------------------------------- |
| `APP_ENV`                          | `development`, `test`, or `production`         |
| `DATABASE_URL`                     | PostgreSQL connection string (per-environment) |
| `AUTH_URL` / `NEXT_PUBLIC_APP_URL` | Must match in production                       |
| `BESEDY_CONFIG`                    | Path to mounted `besedy.toml`                  |

Full variable listings are in the `.env.*.example` files under `web/`.

### Environment File Resolution

Env files are resolved by `scripts/resolve_web_env_file.sh` with this policy: explicit `BESEDY_WEB_ENV_*` override, otherwise `~/.config/lukleh/besedy/web.env.<env>`. The `.env.*.example` templates in `web/` document every supported variable; `just env-check <dev|prod|test>` compares a resolved env file's key names with them (see `docs/web/operations.md`).
