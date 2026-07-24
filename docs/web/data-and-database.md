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
source bytes that were parsed (`v3:sha256:<digest>`). Source snapshots are read
once per reconciliation, before the database transaction and advisory lock, so
fingerprinting and parsing cannot observe different file contents. Older
stat-based fingerprints cause a one-time refresh after upgrade.

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
  - `original_path` from metadata full/original path when available, otherwise archived `Original Path`

Rows missing from one source still exist in `catalog_entry` but remain non-actionable.

### WorkflowVariant Model

`WorkflowVariant` enables alternate listening sources per catalog. Each variant points to a separate archived catalog via `listeningArchivedCatalogPath`. Variant availability is tracked in `catalog_listening_entry`, synced independently from the main catalog entries.

### Audio Source Resolution

When serving audio, the app resolves sources in priority order:

1. **Archived** (compressed) -- primary playback source
2. **Listening variant** -- alternate quality/format from a workflow variant
3. **Original** -- uncompressed source for download

Per-recording source preferences are stored in `user_preferences.settings.audioSources`.

---

## Database

Besedy uses PostgreSQL with Prisma ORM. Schema: `web/prisma/schema.prisma`. Migrations: `web/prisma/migrations/`.

### Migration Workflow

**Create a migration** (development only):

```bash
npx prisma migrate dev --name descriptive_name
```

Run from inside the web container. Commit the new migration directory.

**Apply migrations:**

| Environment | Command                                                     |
| ----------- | ----------------------------------------------------------- |
| Development | `npx prisma migrate deploy` (inside web container)          |
| Test        | `just test-reset` (disposable E2E database on port 5434)    |
| Production  | `just prod-migrate` (uses dedicated `besedy_migrator` user) |

Production runs with least-privilege `besedy_app` for the web process; only the migrator role applies schema changes.

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

- Schema drift check: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma`
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

---

## Configuration

### Data Directories

| Variable             | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `BESEDY_BASE_DIR`    | Root directory scanned for catalog discovery |
| `TEXT_DATA_DIR`      | Catalogs and transcripts                     |
| `AUDIO_DIR`          | Streamable (compressed) audio                |
| `ORIGINAL_AUDIO_DIR` | Downloadable original audio                  |
| `POSTERS_DIR`        | Writable poster storage                      |
| `SOURCES_DIR`        | Writable recording sources storage           |

### Path Mappings

`BESEDY_PATH_MAPPINGS` rewrites host paths found in CSV entries to container-accessible paths at runtime:

```
BESEDY_PATH_MAPPINGS=/mnt/data/audio=/data/original,/mnt/data/text=/data/text
```

Each entry is `<host_prefix>=<container_prefix>`, comma-separated. The app applies these rewrites before path validation. Rules:

- Use full path-prefix boundaries (not fragments that could match unrelated paths)
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

Env files are resolved by `scripts/resolve_web_env_file.sh` with this policy: explicit `BESEDY_WEB_ENV_*` override, otherwise `~/.config/lukleh/besedy/web.env.<env>`. The `.env.*.example` templates in `web/` document every supported variable.
