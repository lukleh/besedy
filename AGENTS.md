# Repository Guidelines

## Project Overview

Besedy is a multilingual speech-to-text toolkit with Czech-focused deployment
presets. It runs a content-addressed pipeline:
catalog → loudness/normalization → transcription/diarization → analysis/verification.
The primary identifier is the SHA-256 **audio hash** computed from decoded 16kHz mono PCM
audio under the explicit `pcm-s16le-16000hz-mono-sha256-v1` contract.

This file is the canonical shared guide for coding agents working in this repo.
Keep shared operational facts here and have provider-specific files such as
`CLAUDE.md` link back here instead of copying command tables or test-user matrices.

## Project Structure & Module Organization

- `besedy/`: main Python package
  - `cli/`: command-line entry points (`catalog.py`, `analyze.py`)
  - `commands/`: subcommand implementations (`catalog/`, `analyze/`)
  - `workflows/`: transcription/diarization runners (e.g. `transcribe_*.py`)
  - `lib/`: core library (audio, data loading, validation, workflow orchestration)
  - `core/`: shared utilities and path/output conventions
- `tests/`: pytest suite (helpers in `tests/helpers/`)
- `docs/`: architecture, data contracts, patterns, and web docs (start with `docs/README.md`)
- `web/`: web app (Prisma + PostgreSQL + Docker)
- Generated artifacts are typically gitignored: `transcripts_*`, `tmp/`, `logs/`

## Build, Test, and Development Commands

- `just --list`: discover available tasks
- `just setup`: install the lean core/dev environment with `uv sync` (Python 3.13; ffmpeg/ffprobe required)
- `just setup-ml`: add optional host-side ML helpers (RAG, speakers, workflow scripts)
- `just setup-jobs`: add optional Prefect jobs tooling
- `just setup-all`: install all optional extras into the host venv
- `just catalog add [dir]`: routine ingest into an existing catalog. With no
  directory it re-scans the catalog's `Scan Root` values.
- `just catalog run-pipeline`: normal operator entry point for processing
  pending catalog entries.
- `just catalog <command>`: run lower-level bootstrap, maintenance, or recovery
  commands (for example `create`, `merge`, `clean`, `check`, `loudness`,
  `stage-audio`, `transcribe`, `diarize`, and `export-transcripts`).
  Source of truth for the complete command surface: `besedy/cli/catalog.py`
  and `tests/test_cli_parser.py`.
- `just analyze <command>`: analysis CLI wrapper (e.g. `just analyze validate`)
- `uv run python besedy/cli/catalog.py validate …`: validate outputs (e.g. `uv run python besedy/cli/catalog.py validate --input-path transcripts/ --batch`)
- `just test` (or `uv run --all-extras pytest`): run the full test suite
- `just web-check`: TypeScript + ESLint + web unit tests
- Always run Python code via `uv run python ...` (instead of plain `python ...`) unless using a `just` wrapper.
- Optional pre-commit (Ruff): `uv tool install pre-commit && pre-commit install` (config in `ruff.toml`)
- Optional backend image builds (one-time, as needed):
  - `docker compose -f backends/docker-compose.yml build whisperx`
  - `docker compose -f backends/docker-compose.yml build nemo`
  - `docker compose -f backends/docker-compose.yml build faster-whisper`
  - `docker compose -f backends/docker-compose.yml build qwen3-asr`
  - `docker compose -f backends/docker-compose.yml build pyannote`

### Web App (Docker)
- Prefer `just dev-up`/`dev-down`, `just prod-up`/`prod-deploy`, and `just test-up`/`test-reset`/`test-fixtures`.
- Those wrap `scripts/run_web_compose.sh <development|production|test> [docker compose args…]`,
  which is the single source of truth for the compose overlays, profile, and resolved
  env file per mode. Use it directly for anything the Justfile does not wrap:
  - Dev (port 3001): `bash scripts/run_web_compose.sh development up -d`
  - Prod (port 3000): `bash scripts/run_web_compose.sh production up -d`
  - Test (port 3002): `bash scripts/run_web_compose.sh test up -d`
- Env files resolve through `scripts/resolve_web_env_file.sh`; when one is missing it
  fails with the `.env.<mode>.example` template to copy and the target path.
- E2E tests run against a **production build** with security hardening (read-only filesystem, dropped capabilities)
- Next.js 16 uses `web/src/proxy.ts` instead of `middleware.ts`; keep auth/request interception there and use `proxy*` config keys in `web/next.config.ts`.

### Web Dependency Compatibility
- Keep ESLint on major 9 until `eslint-config-next`'s React plugin supports
  ESLint 10.
- Before adopting TypeScript 6.1 or newer, confirm the parser brought in by
  `eslint-config-next` has a compatible peer range.
- Do not encode these compatibility notes as Dependabot `ignore` rules:
  ignores can also suppress security updates. Re-evaluate them during
  intentional manual dependency upgrades.

## Coding Style & Naming Conventions

- 4-space indentation; keep functions small and composable.
- Naming: `snake_case` for functions/variables, `PascalCase` for classes, constants in `UPPER_SNAKE_CASE`.
- Keep CLI modules thin: argument parsing in `besedy/cli/*`, business logic in `besedy/commands/*` and `besedy/lib/*`.
- Prefer structured logging and clear error messages over ad-hoc prints.
- Use `load_json_with_fallback()` from `besedy/lib/data/encoding.py` for transcript JSON.
- Resolve config/XDG paths only via the canonical resolvers — `resolve_config_path()` / `_resolve_preferred_config_home()` in `besedy/config/settings.py` and `resolve_xdg_root()` in `besedy/core/paths_common.py`. Don't hardcode or re-derive `~/.config/lukleh/besedy` (or the `lukleh` namespace) anywhere else in the `besedy` Python package; `tests/test_config_guardrail.py` enforces this for `besedy/**/*.py`. (The web app has its own resolver, `web/src/lib/runtime-paths.ts`, and the shell/compose env resolvers are separate single-source points, not covered by this test.)

## Testing Guidelines

- Framework: `pytest` (see markers in `pytest.ini`: `integration`, `gpu`, `slow`, `e2e`).
- Add unit tests for new behavior; if a test needs ffmpeg/GPU/external data, mark it appropriately.
- Examples: `uv run pytest -m "not slow" -q`, `uv run pytest tests/test_cli_parser.py::TestCatalogParserStructure::test_subcommand_names -v`.
- Web unit tests: `npm run test` (from `web/`)
- Web E2E tests: `npm run test:e2e` (Docker-based, uses port 3002; production build with security hardening)

### Web E2E Commands (Playwright)
```bash
cd web

# Run tests (headless) - starts containers, seeds DB, generates fixtures automatically
npm run test:e2e

# Specialized test runs
npm run test:e2e:smoke      # Quick smoke tests only (@smoke tag)
npm run test:e2e:desktop    # Desktop Chrome only
npm run test:e2e:security   # Security tests only (@security tag)

# Interactive modes
npm run test:e2e:ui         # Interactive UI mode
npm run test:e2e:headed     # With visible browser

# Environment management
npm run test:e2e:reset      # Reset database between runs
npm run test:e2e:generate   # Regenerate test fixtures
npm run test:e2e:teardown   # Stop containers (keep data)
npm run test:e2e:teardown:clean  # Stop and delete volumes
```

**Test Environment:**
- E2E tests run against a **production build** with security hardening
- Test web: http://localhost:3002 (dev: 3001, prod: 3000)
- Test DB: localhost:5434 (dev: 5433, prod: 5432)
- Test output: `~/.local/state/lukleh/besedy/web/test-output/<timestamp>/` by default (report, artifacts, results.json)

**Test Users (dev auth mode):**
- Source of truth: `web/prisma/test-data.ts` and `web/tests/e2e/helpers/auth.ts`
- Common seeded accounts: `superadmin`, `admin`, `owner`, `editor`, `member`,
  `viewer`, `listener`, `noaccess`, `pending`, `blocked`
- Keep redirect behavior and auth edge cases out of this file; those flows change
  more often than the seeded identities. Check `docs/web/security.md`,
  `docs/web/architecture.md`, or the relevant route/page code when you need the
  current UX behavior.

**Test Fixtures:** Generated automatically in `web/tests/e2e/fixtures/` (gitignored). Requires `ffmpeg`.

**Web API naming note:** `GET /api/catalog` returns paginated recording entries for
the currently resolved workflow group, while `GET/POST /api/catalogs` lists or
manages workflow-group records themselves.

## CLI Output Conventions (Required)

- Timestamp format: `YYYYMMDD_HHMMSS`.
- Output dirs follow `{base_name}_{timestamp}/` (see `docs/patterns.md`).
- Historical `transcripts_enhanced_*` directory names remain readable for
  compatibility, but no active workflow generates enhanced-audio artifacts.
- Always create/update a symlink `{base_name}/` pointing to the latest timestamped dir.
- Extract timestamps from upstream artifacts (catalog CSV or transcripts dir).
- `export-transcripts` is the exception: it writes sidecars next to `transcript.json`
  and does **not** create a new timestamped output directory.
- Use helpers in `besedy/core/paths.py` and `besedy/commands/catalog/symlink.py`.

## Database Migrations (CRITICAL)

- NEVER use `prisma db push` or `prisma migrate reset` on real data.
- Create migrations with `npx prisma migrate dev --name <name>` in dev containers.
- Apply in dev with `npx prisma migrate deploy`; in prod use `just prod-migrate`.
- See `docs/web/data-and-database.md` for initial bootstrap and full procedures.

## Production DB & Catalog Paths (Reference)

- **Where catalog CSV paths live (DB):** `workflow_group` holds `archived_catalog_path`, `metadata_catalog_path`, `duplicates_catalog_path`, `transcripts_path`; `workflow_variant` holds `listening_archived_catalog_path`. Source of truth: `web/prisma/schema.prisma`.
- **Where container path roots are defined:** the resolved production env file (`BESEDY_WEB_ENV_PROD` or `~/.config/lukleh/besedy/web.env.prod`; see template in `web/.env.prod.example`) defines `TEXT_DATA_DIR`, `AUDIO_DIR`, `ORIGINAL_AUDIO_DIR`, and optional `BESEDY_PATH_MAPPINGS` for host↔container path rewrites.
- **Existing path-mapping logic:** helpers that read production path mappings now use `BESEDY_WEB_ENV_PROD` or `~/.config/lukleh/besedy/web.env.prod`.
- **How to connect to prod DB (local host → prod container):**
  - Prefer service-based exec (no container-name assumptions):
    `bash scripts/run_web_compose.sh production exec -T db psql -U besedy_app -d besedy`
  - Container names follow `besedy-${APP_ENV}-db` from `web/docker-compose.yml` (default prod: `APP_ENV=production` → `besedy-production-db`).
  - Migrations use `besedy_migrator` instead of `besedy_app` (see `docs/web/data-and-database.md`).
- **App DB connection string:** `DATABASE_URL` in the resolved production env file (app user `besedy_app`).

### Common Read-Only Queries (prod)

- List catalogs and CSV paths:
  - `SELECT id, label, metadata_catalog_path, archived_catalog_path, duplicates_catalog_path, transcripts_path FROM workflow_group ORDER BY id DESC;`
- List variants and listening catalogs:
  - `SELECT workflow_group_id, variant, listening_archived_catalog_path FROM workflow_variant ORDER BY workflow_group_id, variant;`
- Metadata rows for a catalog:
  - `SELECT audio_hash, date_year, date_month, date_day, title, artist, part FROM audio_metadata WHERE workflow_group_id = '<catalog_id>' ORDER BY date_year, date_month, date_day;`

## Data & Workflow Notes

- Workflow IDs: `canary-nemo`, `canary-nemo-beam`, `faster-whisper`,
  `whisperx`, `qwen3-asr`, `pyannote`;
  source of truth: `besedy/lib/backend_ids.py`.
- Transcripts live under
  `<workflow>/<output-component>/<audio_hash>/transcript.json` (sidecars
  `transcript.txt|srt|vtt`). The output component appends `@lang-auto` or
  `@lang-<code>` for non-Czech language variants; `cs` (explicit or the
  default when `language` is omitted) retains legacy paths without a suffix.
- The active audio-preparation path is loudness analysis followed by
  `stage-audio`; `run-pipeline` orchestrates it automatically.

## Commit & Pull Request Guidelines

- Commits: short imperative subject (≤72 chars), with a body explaining intent/impact when helpful.
- PRs: describe the change, link relevant issues, and include the exact verification commands you ran (e.g. `just test`).

## Agent-Specific Notes

- Production web revision is exposed at `GET /api/version`.
- Fast check command:
  `curl -s https://besedy.org/api/version | jq -r '.commit, .commitShort, .buildTime, .environment'`
- Local container check:
  `curl -s http://localhost:3000/api/version | jq`

## Important Constraints

1. **Speaker ID Scope**: Speaker identifiers (e.g., `SPEAKER_01`) are unique only within a single audio file.
2. **Loudness Normalization**: Staged audio targets -16 LUFS (acceptable range: -20 to -12 LUFS).
3. **Duration Format**: CSV durations use `HH:MM:SS`.
4. **Audio Hash Directories**: Transcript artifacts use the full 64-character audio hash as the leaf directory.
5. **Timestamped Outputs**: All output-producing CLI commands must follow the timestamp + symlink pattern.
6. **Audio Input Format**: All workflows expect 16kHz mono WAV; use `validate_mono_wav_16k()`.
7. **Workflow Registration**: Add labels in `besedy/core/paths.py` and register in `besedy/lib/workflow/runner.py`.
