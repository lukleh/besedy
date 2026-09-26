# Tasks for running common Besedy workflows.
set shell := ["bash", "-lc"]
set positional-arguments := true

python_lint_surface := "besedy tests"

default:
    @just --list

# Setup Python environment with uv.
setup:
    uv sync

# Setup Python environment with optional host-side ML helpers.
setup-ml:
    uv sync --extra ml

# Setup Python environment with optional Prefect jobs tooling.
setup-jobs:
    uv sync --extra jobs --upgrade-package rlmbenchy

# Setup Python environment with all optional extras.
setup-all:
    uv sync --all-extras --upgrade-package rlmbenchy

# Invoke the audio catalog CLI (e.g., `just catalog create <dir>` or `just catalog check --csv catalog.csv`).
catalog *args:
    uv run python besedy/cli/catalog.py "$@"

# Analysis shortcut
analyze *args:
    uv run python besedy/cli/analyze.py "$@"

# One-off faster-whisper transcription without catalog registration.
transcribe-oneoff *args:
    uv run python besedy/cli/transcribe_oneoff.py "$@"

# Test shortcuts
test *args:
    uv run --all-extras --upgrade-package rlmbenchy pytest "$@"

# Run ty against the full production package.
ty *args:
    uv run ty check besedy {{args}}

# Run Ruff lint checks against production code and tests.
ruff *args:
    uv run ruff check {{ python_lint_surface }} {{args}}

# Apply Ruff formatting to production code and tests.
ruff-format *args:
    uv run ruff format {{ python_lint_surface }} {{args}}

# ============================================================================
# RAG Services (Docker)
# ============================================================================

rag_services_compose := "docker compose -f rag-services/docker-compose.yml"

ensure_internal_network := "docker network inspect \"${BESEDY_INTERNAL_NETWORK:-besedy-internal}\" >/dev/null 2>&1 || docker network create --driver bridge \"${BESEDY_INTERNAL_NETWORK:-besedy-internal}\" >/dev/null"
ensure_prefect_network := "docker network inspect \"${BESEDY_PREFECT_NETWORK:-besedy-prefect}\" >/dev/null 2>&1 || docker network create --driver bridge \"${BESEDY_PREFECT_NETWORK:-besedy-prefect}\" >/dev/null"
ensure_prefect_volume := "docker volume inspect \"${BESEDY_PREFECT_POSTGRES_VOLUME:-besedy_prefect_postgres}\" >/dev/null 2>&1 || docker volume create \"${BESEDY_PREFECT_POSTGRES_VOLUME:-besedy_prefect_postgres}\" >/dev/null"

prefect_compose := "docker compose --env-file \"$(bash scripts/resolve_jobs_env_file.sh prefect)\" -f jobs-service/docker-compose.prefect.yml"

jobs_dev_compose := "docker compose --env-file \"$(bash scripts/resolve_jobs_env_file.sh development)\" -f jobs-service/docker-compose.jobs-dev.yml"

jobs_test_compose := "docker compose --env-file \"$(bash scripts/resolve_jobs_env_file.sh test)\" -f jobs-service/docker-compose.jobs-test.yml"

jobs_prod_compose := "docker compose --env-file \"$(bash scripts/resolve_jobs_env_file.sh production)\" -f jobs-service/docker-compose.jobs-prod.yml"

jobs_prod_codex_compose := "docker compose --env-file \"$(bash scripts/resolve_jobs_env_file.sh production)\" -f jobs-service/docker-compose.jobs-prod.yml -f jobs-service/docker-compose.jobs-codex-auth.yml"

# The ColBERT state bind source, created as the invoking user; Docker would create it as root.
_colbert-state-dir:
    @mkdir -p "${RAG_COLBERT_HOST_DIR:-${BESEDY_STATE_HOME:-$HOME/.local/state/lukleh/besedy}/tmp/rag_colbert}"

rag-services-up: _colbert-state-dir
    {{ rag_services_compose }} up -d

rag-services-down:
    {{ rag_services_compose }} down

rag-services-logs:
    {{ rag_services_compose }} logs -f

embeddings-up: _colbert-state-dir
    {{ rag_services_compose }} up -d

embeddings-down:
    {{ rag_services_compose }} down

embeddings-logs:
    {{ rag_services_compose }} logs -f

tei-up:
    {{ rag_services_compose }} --profile legacy-tei up -d embeddings reranker

tei-down:
    {{ rag_services_compose }} stop embeddings reranker

tei-logs:
    {{ rag_services_compose }} logs -f embeddings reranker

colbert-up: _colbert-state-dir
    {{ rag_services_compose }} up -d --build colbert

colbert-down:
    {{ rag_services_compose }} stop colbert

colbert-logs:
    {{ rag_services_compose }} logs -f colbert

# ============================================================================
# Prefect Control Plane and Jobs Runtimes (Docker)
# ============================================================================

prefect-up:
    {{ ensure_prefect_network }}
    {{ ensure_prefect_volume }}
    {{ prefect_compose }} up -d

prefect-down:
    {{ prefect_compose }} down

prefect-down-clean:
    {{ prefect_compose }} down
    @echo "Prefect DB volume is external and was not removed."

prefect-logs:
    {{ prefect_compose }} logs -f

prefect-rebuild:
    just prefect-up

prefect-status:
    {{ prefect_compose }} ps

prefect-db:
    {{ prefect_compose }} exec prefect-postgres psql -U ${PREFECT_POSTGRES_USER:-prefect} ${PREFECT_POSTGRES_DB:-prefect}

prefect-deploy:
    just jobs-dev-deploy

# A jobs runtime with an empty BESEDY_JOB_SERVICE_SECRET stays healthy but
# answers 401 to every web request, so refuse to start one.
_jobs-secret-check mode:
    #!/usr/bin/env bash
    set -euo pipefail
    jobs_env="$(bash scripts/resolve_jobs_env_file.sh {{ mode }})"
    secret="$(
        . "$jobs_env"
        printf '%s' "${BESEDY_JOB_SERVICE_SECRET:-}"
    )"
    if [ -z "${secret//[[:space:]]/}" ]; then
        echo "BESEDY_JOB_SERVICE_SECRET is empty in $jobs_env; set it to the value in the web env file of the same environment." >&2
        exit 1
    fi

jobs-dev-up: (_jobs-secret-check "development")
    just prefect-up
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    {{ jobs_dev_compose }} build --build-arg RLMBENCHY_REFRESH="$(date +%s)" jobs-api prefect-worker
    {{ jobs_dev_compose }} up -d --no-build

jobs-dev-down:
    {{ jobs_dev_compose }} down

jobs-dev-logs:
    {{ jobs_dev_compose }} logs -f

jobs-dev-rebuild:
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    {{ jobs_dev_compose }} build --build-arg RLMBENCHY_REFRESH="$(date +%s)" jobs-api prefect-worker
    {{ jobs_dev_compose }} up -d --no-build jobs-api prefect-worker

jobs-dev-status:
    {{ jobs_dev_compose }} ps

jobs-dev-deploy:
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    {{ jobs_dev_compose }} run --rm jobs-api python -m besedy.lib.prefect_jobs.deploy

jobs-test-up: (_jobs-secret-check "test")
    just prefect-up
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    {{ jobs_test_compose }} build --build-arg RLMBENCHY_REFRESH="$(date +%s)" jobs-api prefect-worker
    {{ jobs_test_compose }} up -d --no-build

jobs-test-down:
    {{ jobs_test_compose }} down

jobs-test-logs:
    {{ jobs_test_compose }} logs -f

jobs-test-rebuild:
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    {{ jobs_test_compose }} build --build-arg RLMBENCHY_REFRESH="$(date +%s)" jobs-api prefect-worker
    {{ jobs_test_compose }} up -d --no-build jobs-api prefect-worker

jobs-test-status:
    {{ jobs_test_compose }} ps

jobs-test-deploy:
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    {{ jobs_test_compose }} run --rm jobs-api python -m besedy.lib.prefect_jobs.deploy

jobs-prod-up: (_jobs-secret-check "production")
    just prefect-up
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    just jobs-prod-build
    {{ jobs_prod_compose }} up -d --no-build

# Start production with the narrowly scoped Codex auth overlay for
# model-chatgpt-* profiles.
jobs-prod-up-codex: (_jobs-secret-check "production")
    just prefect-up
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    just jobs-prod-build
    {{ jobs_prod_codex_compose }} up -d --no-build

jobs-prod-build:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
        echo "Refusing to build a production jobs image from a dirty worktree." >&2
        exit 1
    fi
    export GIT_COMMIT="$(git rev-parse HEAD)"
    export BUILD_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    jobs_env="$(bash scripts/resolve_jobs_env_file.sh production)"
    set -a
    . "$jobs_env"
    set +a
    {{ jobs_prod_compose }} build --pull \
        --build-arg RLMBENCHY_REFRESH="$(date +%s)" \
        jobs-api
    docker image tag "${BESEDY_JOBS_IMAGE:-besedy-jobs:prod}" "besedy-jobs:$GIT_COMMIT"
    echo "Built production jobs image for commit ${GIT_COMMIT:0:12}"

jobs-prod-down:
    {{ jobs_prod_compose }} down

# Pause the production jobs writers without removing their containers.
jobs-prod-stop:
    {{ jobs_prod_compose }} stop jobs-api prefect-worker

# Refuse coordinated maintenance while the production deployment has queued or
# running work. Run this once before downtime and again after submissions stop.
jobs-prod-check-idle:
    {{ jobs_prod_compose }} run --rm --no-deps jobs-api \
        python -m besedy.lib.prefect_jobs.maintenance

# Start production jobs from the already-built image.
jobs-prod-start:
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    {{ jobs_prod_compose }} up -d --no-build jobs-api prefect-worker

# Start production jobs with the narrowly scoped Codex auth overlay.
jobs-prod-start-codex:
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    {{ jobs_prod_codex_compose }} up -d --no-build jobs-api prefect-worker

jobs-prod-logs:
    {{ jobs_prod_compose }} logs -f

jobs-prod-rebuild:
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    just jobs-prod-build
    {{ jobs_prod_compose }} up -d --no-build jobs-api prefect-worker

jobs-prod-rebuild-codex:
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    just jobs-prod-build
    {{ jobs_prod_codex_compose }} up -d --no-build jobs-api prefect-worker

jobs-prod-status:
    {{ jobs_prod_compose }} ps

jobs-prod-deploy:
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    {{ jobs_prod_compose }} run --rm jobs-api python -m besedy.lib.prefect_jobs.deploy

# Run the host-side ingest Prefect worker in the foreground. It needs Docker,
# the GPU backends, ffmpeg and the host besedy.toml; see
# jobs-service/host-worker/ingest-worker.env.example for the required env.
ingest-worker-run:
    #!/usr/bin/env bash
    set -euo pipefail
    env_file="${BESEDY_INGEST_WORKER_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/lukleh/besedy/ingest-worker.env}"
    if [ -f "$env_file" ]; then
        set -a
        . "$env_file"
        set +a
    else
        echo "Ingest worker env file not found: $env_file (copy jobs-service/host-worker/ingest-worker.env.example)" >&2
    fi
    exec uv run --extra jobs prefect worker start \
        --pool "${PREFECT_INGEST_WORK_POOL:-besedy-ingest-dev}" \
        --type process --limit 1 --install-policy never

# Backward-compatible aliases while the old jobs-* naming is phased out.
jobs-up:
    just jobs-dev-up

jobs-down:
    just jobs-dev-down

jobs-down-clean:
    just jobs-dev-down

jobs-logs:
    just jobs-dev-logs

jobs-rebuild:
    just jobs-dev-rebuild

jobs-status:
    just jobs-dev-status

jobs-db:
    just prefect-db

jobs-deploy:
    just jobs-dev-deploy

# ============================================================================
# Web App - Code Quality Checks
# ============================================================================

# Run all web checks (TypeScript, ESLint, unit tests)
web-check:
    #!/usr/bin/env bash
    set -e
    cd web
    if [ ! -x node_modules/.bin/next ]; then
        echo "Web dependencies are not installed; run: (cd web && npm ci)" >&2
        exit 1
    fi
    echo "Running TypeScript type check..."
    npm run type-check
    echo "Running ESLint..."
    node node_modules/eslint/bin/eslint.js src/
    echo "Running unit tests..."
    npm run test
    echo "All checks passed!"

# TypeScript type check only
web-typecheck:
    cd web && npm run type-check

# ESLint only
web-lint:
    cd web && node node_modules/eslint/bin/eslint.js src/

# Unit tests only
web-test:
    cd web && npm run test

# ============================================================================
# Web App - Operator Tools
# ============================================================================

# Event artwork candidates and publication (see: just artwork --help)
artwork *args:
    cd web && npm run artwork -- "$@"

# One-time storage rename: posters_<catalogId> -> artwork_<catalogId> (see: just artwork-storage --help)
artwork-storage *args:
    cd web && npm run storage:artwork-rename -- "$@"

# ============================================================================
# Web App - Development (port 3001)
# ============================================================================

# Dev compose command (with source mount for hot reloading)
dev_compose := "bash ../scripts/run_web_compose.sh development"
prod_compose := "bash ../scripts/run_web_compose.sh production"
test_compose := "bash ../scripts/run_web_compose.sh test"

# Compare a mode's env file with its Compose files and template (key names only).
# Fails only when keys the Compose files require are missing.
env-check mode:
    bash scripts/run_web_compose.sh {{ mode }} env-check

# Start dev environment (detached)
dev-up:
    cd web && {{ dev_compose }} up -d

# Start dev with pgAdmin
dev-up-tools:
    cd web && {{ dev_compose }} --profile tools up -d

# Stop dev environment (keeps data)
dev-down:
    cd web && {{ dev_compose }} down

# Stop dev and delete volumes
dev-down-clean:
    cd web && {{ dev_compose }} down -v

# Restart web container
dev-restart:
    cd web && {{ dev_compose }} restart web

# Rebuild and restart web container
dev-rebuild:
    cd web && {{ dev_compose }} up -d --build --renew-anon-volumes web

# Follow web logs
dev-logs:
    cd web && {{ dev_compose }} logs -f web

# Follow all logs
dev-logs-all:
    cd web && {{ dev_compose }} logs -f

# Shell into web container
dev-shell:
    cd web && {{ dev_compose }} exec web sh

# Access database shell
dev-db:
    cd web && {{ dev_compose }} exec db psql -U besedy besedy

# Run database migrations
dev-migrate:
    cd web && {{ dev_compose }} exec web npx prisma migrate deploy

# Seed test users for development
dev-seed:
    cd web && {{ dev_compose }} exec web npm run db:seed:dev

# Show container status
dev-status:
    cd web && {{ dev_compose }} ps

# ============================================================================
# Web App - Production (port 3000)
# ============================================================================

# Start prod environment with version tracking
prod-up:
    #!/usr/bin/env bash
    set -euo pipefail
    cd web
    env_file="$(bash ../scripts/resolve_web_env_file.sh production)"
    set -a
    . "$env_file"
    set +a
    export GIT_COMMIT=$(git rev-parse HEAD)
    WEB_VERSION="$(bash ../scripts/resolve_web_version.sh)"
    export WEB_VERSION
    export BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
    {{ prod_compose }} up -d --no-recreate --remove-orphans

# Stop prod environment (keeps data)
prod-down:
    cd web && {{ prod_compose }} down

# Stop prod and remove non-external volumes (the production DB volume is external)
prod-down-clean:
    cd web && {{ prod_compose }} down -v

# Restart web container
prod-restart:
    cd web && {{ prod_compose }} restart web

# Rebuild with version tracking
prod-rebuild:
    #!/usr/bin/env bash
    set -euo pipefail
    bash scripts/validate_web_config_mount.sh production
    echo "Running web checks..."
    just web-check
    cd web
    env_file="$(bash ../scripts/resolve_web_env_file.sh production)"
    if [ ! -f "$env_file" ]; then
        echo "Missing production env file: $env_file"
        exit 1
    fi
    set -a
    . "$env_file"
    set +a
    require_env() {
        if [ -z "${!1:-}" ]; then
            echo "Missing required env: $1 ($env_file)"
            exit 1
        fi
    }
    require_env AUTH_URL
    require_env NEXT_PUBLIC_APP_URL
    require_env AUTH_SECRET
    require_env AUTH_GOOGLE_ID
    require_env AUTH_GOOGLE_SECRET
    require_env DATABASE_URL
    require_env VAPID_PUBLIC_KEY
    require_env NEXT_PUBLIC_VAPID_PUBLIC_KEY
    require_env VAPID_PRIVATE_KEY
    if [ "$NEXT_PUBLIC_APP_URL" != "$AUTH_URL" ]; then
        echo "NEXT_PUBLIC_APP_URL must match AUTH_URL for production"
        exit 1
    fi
    if [ "$NEXT_PUBLIC_VAPID_PUBLIC_KEY" != "$VAPID_PUBLIC_KEY" ]; then
        echo "NEXT_PUBLIC_VAPID_PUBLIC_KEY must match VAPID_PUBLIC_KEY for production"
        exit 1
    fi
    export GIT_COMMIT=$(git rev-parse HEAD)
    WEB_VERSION="$(bash ../scripts/resolve_web_version.sh)"
    export WEB_VERSION
    export BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
    {{ prod_compose }} build --pull --no-cache web
    {{ prod_compose }} up -d --no-deps web

# Build the production web image and run its checks without changing runtime.
prod-build:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
        echo "Refusing to build a production web image from a dirty worktree." >&2
        exit 1
    fi
    jobs_env="$(bash scripts/resolve_jobs_env_file.sh production)"
    if [ ! -f "$jobs_env" ]; then
        echo "Missing production jobs env file: $jobs_env" >&2
        exit 1
    fi
    jobs_image="$(
        . "$jobs_env"
        printf '%s' "${BESEDY_JOBS_IMAGE:-besedy-jobs:prod}"
    )"
    bash scripts/validate_web_config_mount.sh production
    echo "Running web checks..."
    just web-check
    cd web
    env_file="$(bash ../scripts/resolve_web_env_file.sh production)"
    if [ ! -f "$env_file" ]; then
        echo "Missing production env file: $env_file"
        exit 1
    fi
    set -a
    . "$env_file"
    set +a
    require_env() {
        if [ -z "${!1:-}" ]; then
            echo "Missing required env: $1 ($env_file)"
            exit 1
        fi
    }
    require_env AUTH_URL
    require_env NEXT_PUBLIC_APP_URL
    require_env AUTH_SECRET
    require_env AUTH_GOOGLE_ID
    require_env AUTH_GOOGLE_SECRET
    require_env DATABASE_URL
    require_env VAPID_PUBLIC_KEY
    require_env NEXT_PUBLIC_VAPID_PUBLIC_KEY
    require_env VAPID_PRIVATE_KEY
    if [ "$NEXT_PUBLIC_APP_URL" != "$AUTH_URL" ]; then
        echo "NEXT_PUBLIC_APP_URL must match AUTH_URL for production"
        exit 1
    fi
    if [ "$NEXT_PUBLIC_VAPID_PUBLIC_KEY" != "$VAPID_PUBLIC_KEY" ]; then
        echo "NEXT_PUBLIC_VAPID_PUBLIC_KEY must match VAPID_PUBLIC_KEY for production"
        exit 1
    fi
    echo "Building production with version tracking..."
    export GIT_COMMIT=$(git rev-parse HEAD)
    WEB_VERSION="$(bash ../scripts/resolve_web_version.sh)"
    export WEB_VERSION
    export BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
    {{ prod_compose }} build --pull web
    docker image tag "${BESEDY_WEB_IMAGE:-besedy-web:prod}" "besedy-web:$GIT_COMMIT"
    echo "Retained production web image: besedy-web:$GIT_COMMIT"
    if docker image inspect "$jobs_image" >/dev/null 2>&1; then
        docker image tag "$jobs_image" "besedy-jobs:$GIT_COMMIT"
        echo "Retained current production jobs image: besedy-jobs:$GIT_COMMIT"
    else
        echo "Warning: no deployed jobs image found at $jobs_image; skipping its rollback snapshot." >&2
        echo "A coordinated deployment will build and retain the jobs image before downtime." >&2
    fi

# Stop the web writer and scheduled backup, create a verified backup, migrate,
# and start the image previously produced by prod-build. A failure deliberately
# leaves web and the scheduled backup stopped.
prod-apply:
    #!/usr/bin/env bash
    set -euo pipefail
    cd web
    env_file="$(bash ../scripts/resolve_web_env_file.sh production)"
    set -a
    . "$env_file"
    set +a
    git_commit=$(git rev-parse HEAD)
    web_image="${BESEDY_WEB_IMAGE:-besedy-web:prod}"
    image_commit="$(docker image inspect "$web_image" | jq -er '.[0].Config.Labels["org.opencontainers.image.revision"] // empty')" || {
        echo "Cannot determine the source commit for production image: $web_image" >&2
        echo "Run just prod-build from this checkout before applying it." >&2
        exit 1
    }
    if [ "$image_commit" != "$git_commit" ]; then
        echo "Refusing to apply commit $git_commit with web image $web_image built from $image_commit." >&2
        echo "Run just prod-build from this checkout before applying it." >&2
        exit 1
    fi
    # The application is deliberately unavailable during migration. Several
    # permission migrations change constraints as well as adding columns, so
    # neither the old nor new process may write while the schema is between
    # versions.
    echo "Stopping web and scheduled backup for database maintenance..."
    {{ prod_compose }} stop web backup
    # On a fresh host nothing has started the database yet. --no-recreate
    # leaves an existing database container untouched.
    echo "Ensuring the database is running..."
    {{ prod_compose }} up -d --no-deps --no-recreate --wait db
    echo "Creating a pre-migration backup..."
    just prod-backup
    echo "Running migrations..."
    just prod-migrate
    echo "Starting the migrated web service and scheduled backup..."
    {{ prod_compose }} up -d --no-deps --no-build --remove-orphans web backup
    # Authoritative deploy record: what actually went live, and when -- as
    # opposed to a commit's timestamp, which only says when the code changed.
    # Best-effort and non-fatal: the deploy above already succeeded, so a
    # logging hiccup here shouldn't turn a good deploy into a failed one.
    web_container_id="$({{ prod_compose }} ps -q web 2>/dev/null || true)"
    web_version=""
    if [ -n "$web_container_id" ]; then
        web_version="$(docker exec "$web_container_id" printenv WEB_VERSION 2>/dev/null || true)"
    fi
    deployed_by="$(git config user.name 2>/dev/null || true)"
    deployed_by="${deployed_by:-$(whoami)}"
    db_container_id="$({{ prod_compose }} ps -q db 2>/dev/null || true)"
    # Same "is this a real version" test as normalizeWebVersion (web/src/lib/service-worker/version.ts):
    # non-empty and not the literal "unknown" sentinel. Deliberately not
    # restating the web-v2-<hash> shape here too -- a third hardcoded copy of
    # that format would silently stop matching (and silently stop logging
    # deploys) the next time the version scheme changes.
    if [ -n "$web_version" ] && [ "$web_version" != "unknown" ] && [ -n "$db_container_id" ]; then
        # Piped via stdin rather than -c: psql only performs :'var' literal
        # interpolation (the safe-quoting mechanism) on script input, not on
        # a -c command string.
        if deploy_log_output="$(
            docker exec -i "$db_container_id" psql -U besedy_app -d besedy -v ON_ERROR_STOP=1 \
                -v git_commit="$git_commit" -v web_version="$web_version" -v deployed_by="$deployed_by" \
                <<< "INSERT INTO web_deploy_log (git_commit, web_version, deployed_by) VALUES (:'git_commit', :'web_version', :'deployed_by');" 2>&1
        )"; then
            echo "Recorded deploy in web_deploy_log ($web_version)."
        else
            echo "WARNING: deploy succeeded but could not be recorded in web_deploy_log:" >&2
            printf '%s\n' "$deploy_log_output" >&2
        fi
    else
        echo "WARNING: could not determine web_version or db container; skipping web_deploy_log entry." >&2
    fi
    echo "Deployment complete. Commit: ${git_commit:0:7}"
    echo "Verify: curl -s http://localhost:3000/api/version | jq"

# Full production web deployment.
prod-deploy:
    just prod-build
    just prod-apply

# Quiesce web and the jobs API, verify that no run raced the initial idle check,
# then stop the worker and apply the migration. If that second check finds work,
# restart the unchanged containers and leave the database untouched.
_prod-apply-with-jobs jobs_start:
    #!/usr/bin/env bash
    set -euo pipefail
    just jobs-prod-check-idle
    cd web
    {{ prod_compose }} stop web
    cd ..
    {{ jobs_prod_compose }} stop jobs-api
    if ! just jobs-prod-check-idle; then
        echo "A Prefect run started while services were being quiesced; restoring service without migrating." >&2
        {{ jobs_prod_compose }} start jobs-api
        cd web
        {{ prod_compose }} start web
        exit 1
    fi
    {{ jobs_prod_compose }} stop prefect-worker
    just prod-apply
    just {{ jobs_start }}
    just jobs-prod-deploy

# Coordinated deployment for revisions that change both web and jobs contracts.
# Both images are built before downtime. New submissions are stopped before the
# worker, so active work is never abandoned by the deployment.
prod-deploy-with-jobs:
    just prod-build
    just jobs-prod-build
    just _prod-apply-with-jobs jobs-prod-start

# The same coordinated deployment for model-chatgpt-* production profiles.
prod-deploy-with-jobs-codex:
    just prod-build
    just jobs-prod-build
    just _prod-apply-with-jobs jobs-prod-start-codex

# Create and validate an immediate production database backup. This uses the
# same credentials and host-mounted backup directory as the scheduled service.
prod-backup:
    #!/usr/bin/env bash
    set -euo pipefail
    cd web
    git_commit="$(git rev-parse HEAD)"
    {{ prod_compose }} run --rm --no-deps --entrypoint /bin/sh backup -c '
        set -eu
        commit="$1"
        mkdir -p /backups/deploy
        FILENAME="/backups/deploy/besedy_deploy_${commit}_$(date +%Y%m%d_%H%M%S).sql.gz"
        SQL_FILE="${FILENAME%.gz}.tmp"
        ARCHIVE="$FILENAME.tmp"
        cleanup() { rm -f "$SQL_FILE" "$ARCHIVE"; }
        trap cleanup EXIT
        echo "Creating retained deployment backup: $FILENAME"
        pg_dump > "$SQL_FILE"
        test -s "$SQL_FILE"
        gzip -c "$SQL_FILE" > "$ARCHIVE"
        gzip -t "$ARCHIVE"
        test -s "$ARCHIVE"
        mv "$ARCHIVE" "$FILENAME"
        rm -f "$SQL_FILE"
        trap - EXIT
        echo "Backup verified: $FILENAME"
    ' sh "$git_commit"

# Restore one retained deployment backup. All database clients managed by these
# stacks must already be stopped, and the confirmation must repeat the exact
# relative path under BACKUP_DIR.
prod-restore *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$#" -ne 1 ]; then
        echo "Usage: CONFIRM_PROD_RESTORE=deploy/<backup>.sql.gz just prod-restore deploy/<backup>.sql.gz" >&2
        exit 2
    fi
    backup="$1"
    case "$backup" in
        deploy/besedy_deploy_*.sql.gz) ;;
        *) echo "Restore accepts only retained deploy/*.sql.gz backups." >&2; exit 2 ;;
    esac
    if [ "${CONFIRM_PROD_RESTORE:-}" != "$backup" ]; then
        echo "Refusing destructive restore. Set CONFIRM_PROD_RESTORE=$backup" >&2
        exit 2
    fi
    cd web
    if [ -n "$({{ prod_compose }} ps --services --status running web)" ]; then
        echo "Stop the production web service before restoring." >&2
        exit 1
    fi
    if [ -n "$({{ prod_compose }} ps --services --status running backup)" ]; then
        echo "Stop the production scheduled backup service before restoring." >&2
        exit 1
    fi
    cd ..
    if [ -n "$({{ jobs_prod_compose }} ps --services --status running jobs-api prefect-worker)" ]; then
        echo "Stop the production jobs API and worker before restoring." >&2
        exit 1
    fi
    cd web
    {{ prod_compose }} run --rm --no-deps --entrypoint /bin/sh backup -c '
        set -eu
        backup="/backups/$1"
        test -f "$backup"
        test -s "$backup"
        gzip -t "$backup"
        echo "Archive verified; replacing database $PGDATABASE from $backup"
        dropdb --if-exists --force "$PGDATABASE"
        createdb --owner="$PGUSER" "$PGDATABASE"
        gzip -dc "$backup" | psql --dbname="$PGDATABASE" --set=ON_ERROR_STOP=1
        echo "Database restore completed: $backup"
    ' sh "$backup"

# Restore a retained database backup and restart the exact web/jobs images from
# a previous coordinated deployment. The selected jobs start recipe preserves
# whether production uses the Codex auth overlay. The confirmation binds both
# user-provided inputs.
_prod-rollback jobs_start commit backup:
    #!/usr/bin/env bash
    set -euo pipefail
    jobs_start="$1"
    commit="$2"
    backup="$3"
    if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Rollback requires the full 40-character source commit." >&2
        exit 2
    fi
    if [ "${CONFIRM_PROD_ROLLBACK:-}" != "$commit:$backup" ]; then
        echo "Refusing rollback. Set CONFIRM_PROD_ROLLBACK=$commit:$backup" >&2
        exit 2
    fi
    docker image inspect "besedy-web:$commit" >/dev/null
    docker image inspect "besedy-jobs:$commit" >/dev/null
    just jobs-prod-check-idle
    cd web
    {{ prod_compose }} stop web backup
    cd ..
    {{ jobs_prod_compose }} stop jobs-api prefect-worker
    echo "Preserving the current failed state before restoring..."
    just prod-backup
    CONFIRM_PROD_RESTORE="$backup" just prod-restore "$backup"
    cd web
    BESEDY_WEB_IMAGE="besedy-web:$commit" {{ prod_compose }} up -d --no-deps --no-build web backup
    cd ..
    BESEDY_JOBS_IMAGE="besedy-jobs:$commit" just "$jobs_start"
    BESEDY_JOBS_IMAGE="besedy-jobs:$commit" just jobs-prod-deploy
    echo "Rollback complete. Verify web, jobs, and permissions before reopening maintenance."

# Roll back a standard OpenRouter/NVIDIA production jobs deployment.
prod-rollback commit backup:
    just _prod-rollback jobs-prod-start "$1" "$2"

# Roll back a model-chatgpt-* deployment while retaining its Codex auth mount.
prod-rollback-codex commit backup:
    just _prod-rollback jobs-prod-start-codex "$1" "$2"

# Check deployed version
prod-version:
    @curl -s http://localhost:3000/api/version | jq

# Follow web logs
prod-logs:
    cd web && {{ prod_compose }} logs -f web

# Follow all logs
prod-logs-all:
    cd web && {{ prod_compose }} logs -f

# Shell into web container
prod-shell:
    cd web && {{ prod_compose }} exec web sh

# Access database shell
prod-db:
    cd web && {{ prod_compose }} exec db psql -U besedy besedy

# Run database migrations (from host as migrator user)
prod-migrate:
    #!/usr/bin/env bash
    set -euo pipefail
    cd web
    env_file="$(bash ../scripts/resolve_web_env_file.sh production)"
    if [ ! -f "$env_file" ]; then
        echo "Error: production env file not found: $env_file"
        exit 1
    fi
    set -a
    source "$env_file"
    set +a
    db_host="${DB_HOST:-localhost}"
    db_port_value="${DB_PORT:-5432}"
    if [[ "$db_port_value" == *:* ]]; then
        db_host="${db_port_value%%:*}"
        db_port_value="${db_port_value##*:}"
    fi
    export DATABASE_URL="postgresql://besedy_migrator:${MIGRATE_PASSWORD}@${db_host}:${db_port_value}/${POSTGRES_DB:-besedy}"
    echo "Running migrations as besedy_migrator..."
    npx prisma migrate deploy
    echo "Granting app user permissions and preserving audit-log hardening..."
    {{ prod_compose }} exec -T db \
        psql -U "${POSTGRES_USER:-besedy}" -d "${POSTGRES_DB:-besedy}" \
        -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO besedy_app;" \
        -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO besedy_app;" \
        -c "REVOKE DELETE ON TABLE public.audit_log FROM besedy_app;"

# Show container status
prod-status:
    cd web && {{ prod_compose }} ps

# Monitor session/auth health (run after deployment)
prod-monitor *args:
    ./scripts/monitor-session-health.sh {{ args }}

# ============================================================================
# Web App - E2E Tests (port 3002)
# ============================================================================

# Start test environment (always resets DB for clean state)
test-up:
    #!/usr/bin/env bash
    set -e
    cd web

    # Start containers
    echo "Starting test containers..."
    {{ test_compose }} up -d

    resolve_test_port() {
      local endpoint
      endpoint="$({{ test_compose }} port "$1" "$2" | head -n 1)"
      endpoint="${endpoint##*:}"
      if [[ ! "$endpoint" =~ ^[0-9]+$ ]] || [[ "$endpoint" == "0" ]]; then
        echo "Could not resolve the published port for $1:$2" >&2
        exit 1
      fi
      printf '%s\n' "$endpoint"
    }

    # Wait for DB to be ready
    echo "Waiting for database..."
    for i in {1..30}; do
      if {{ test_compose }} exec -T db pg_isready -h 127.0.0.1 -U besedy_test > /dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    # Always reset DB for fresh state
    echo "Resetting database..."
    {{ test_compose }} exec -T db \
      psql -U besedy_test -d besedy_test -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" > /dev/null

    echo "Applying migrations..."
    test_db_port="$(resolve_test_port db 5432)"
    test_database_url="postgresql://besedy_test:besedy_test@127.0.0.1:${test_db_port}/besedy_test"
    DATABASE_URL="$test_database_url" npx prisma migrate deploy

    echo "Seeding test data..."
    DATABASE_URL="$test_database_url" npx tsx prisma/seed-test.ts

    # Wait for web server
    echo "Waiting for web server..."
    test_web_port="$(resolve_test_port web 3000)"
    web_ready=false
    for i in {1..60}; do
      if curl -sf "http://127.0.0.1:${test_web_port}/api/health" > /dev/null 2>&1; then
        web_ready=true
        break
      fi
      sleep 1
    done
    if [[ "$web_ready" != true ]]; then
      echo "Test web server did not become ready on port $test_web_port" >&2
      exit 1
    fi

    echo "Test environment ready on port $test_web_port"

# Stop test containers (keeps data)
test-down:
    cd web && {{ test_compose }} down

# Stop and delete test volumes
test-down-clean:
    cd web && {{ test_compose }} down -v

# Restart web container
test-restart:
    cd web && {{ test_compose }} restart web

# Rebuild and restart web container
test-rebuild:
    cd web && {{ test_compose }} up -d --build web

# Follow web logs
test-logs:
    cd web && {{ test_compose }} logs -f web

# Follow all logs
test-logs-all:
    cd web && {{ test_compose }} logs -f

# Shell into web container
test-shell:
    cd web && {{ test_compose }} exec web sh

# Access database shell
test-db:
    cd web && {{ test_compose }} exec db psql -U besedy_test besedy_test

# Run database migrations (from host)
test-migrate:
    cd web && DATABASE_URL=postgresql://besedy_test:besedy_test@localhost:5434/besedy_test npx prisma migrate deploy

# Seed test data (from host)
test-seed:
    cd web && DATABASE_URL=postgresql://besedy_test:besedy_test@localhost:5434/besedy_test npx tsx prisma/seed-test.ts

# Show container status
test-status:
    cd web && {{ test_compose }} ps

# Reset database mid-session (if tests corrupt data)
test-reset:
    #!/usr/bin/env bash
    set -e
    cd web
    echo "Resetting test database..."
    {{ test_compose }} exec -T db \
      psql -U besedy_test -d besedy_test -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" > /dev/null
    echo "Applying migrations..."
    DATABASE_URL=postgresql://besedy_test:besedy_test@localhost:5434/besedy_test npx prisma migrate deploy
    echo "Seeding data..."
    DATABASE_URL=postgresql://besedy_test:besedy_test@localhost:5434/besedy_test npx tsx prisma/seed-test.ts
    echo "Reset complete!"

# Generate/update test fixtures
test-fixtures:
    cd web && npm run test:e2e:generate

# Check if test environment is ready
test-ready:
    #!/usr/bin/env bash
    set -e
    cd web
    echo "Checking test environment..."

    # Check containers running
    if ! {{ test_compose }} ps --format json | grep -q "besedy-test-web"; then
      echo "Containers not running. Run: just test-up"
      exit 1
    fi

    # Check DB ready
    if ! {{ test_compose }} exec -T db pg_isready -h 127.0.0.1 -U besedy_test > /dev/null 2>&1; then
      echo "Database not ready"
      exit 1
    fi

    # Check web ready
    if ! curl -sf http://localhost:3002/api/health > /dev/null; then
      echo "Web server not ready"
      exit 1
    fi

    echo "Test environment ready"

# Rebuild this checkout and run the authenticated MCP v2 smoke test.
mcp-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    repo_root="$PWD"
    test_env_file="$(bash scripts/resolve_web_env_file.sh test)"
    unset APP_ENV CONFIG_FILE
    set -a
    . "$test_env_file"
    set +a
    if [[ "${APP_ENV:-}" != "test" ]]; then
      echo "Refusing MCP smoke: the resolved test env must set APP_ENV=test" >&2
      exit 1
    fi
    source_config="${CONFIG_FILE:-$repo_root/web/besedy.docker.toml}"
    if [[ "$source_config" != /* ]]; then
      source_config="$repo_root/web/${source_config#./}"
    fi
    fixture_dir="$repo_root/web/tests/e2e/mcp-fixtures"
    rag_mock="$repo_root/web/tests/e2e/rag-mock/server.mjs"
    export BESEDY_WEB_COMPOSE_INSTANCE="test-mcp-$(date -u +%Y%m%d%H%M%S)-$$"
    export BESEDY_WEB_ALLOW_TEST_OVERRIDES=1
    export WEB_PORT=127.0.0.1:0
    export DB_PORT=127.0.0.1:0
    runtime_dir="$repo_root/web/.playwright-mcp/$BESEDY_WEB_COMPOSE_INSTANCE"
    rag_container="besedy-mcp-rag-${RANDOM}-$$"
    cleanup() {
      docker rm -f "$rag_container" > /dev/null 2>&1 || true
      (cd "$repo_root/web" && bash ../scripts/run_web_compose.sh test down -v --rmi local) > /dev/null 2>&1 || true
      rm -rf "$runtime_dir"
    }
    resolve_mcp_port() {
      local endpoint
      endpoint="$(cd "$repo_root/web" && bash ../scripts/run_web_compose.sh test port "$1" "$2" | head -n 1)"
      endpoint="${endpoint##*:}"
      if [[ ! "$endpoint" =~ ^[0-9]+$ ]] || [[ "$endpoint" == "0" ]]; then
        echo "Could not resolve the MCP port for $1:$2" >&2
        exit 1
      fi
      printf '%s\n' "$endpoint"
    }
    trap cleanup EXIT
    mkdir -p "$runtime_dir"
    install -m 0644 "$source_config" "$runtime_dir/besedy.docker.toml"
    chmod a+r "$rag_mock"
    chmod -R a+rX "$fixture_dir"
    export CONFIG_FILE="$runtime_dir/besedy.docker.toml"
    export TEXT_DATA_DIR="$fixture_dir"
    export BESEDY_MCP_ENABLED=true
    export RAG_COLBERT_URL="http://$rag_container:18192/query"
    export RAG_COLBERT_INDEX_DIR=
    export RAG_COLBERT_RERANK_ENABLED=false
    just test-up
    mcp_web_port="$(resolve_mcp_port web 3000)"
    mcp_db_port="$(resolve_mcp_port db 5432)"
    export WEB_PORT="127.0.0.1:$mcp_web_port"
    export AUTH_URL="http://127.0.0.1:$mcp_web_port"
    export NEXT_PUBLIC_APP_URL="$AUTH_URL"
    export AUTH_DEV_TRUSTED_ORIGINS="$AUTH_URL,http://localhost:$mcp_web_port"
    docker run -d \
      --name "$rag_container" \
      --network "${BESEDY_INTERNAL_NETWORK:-besedy-internal}" \
      --mount "type=bind,source=$rag_mock,target=/mock/server.mjs,readonly" \
      node:24-alpine node /mock/server.mjs > /dev/null
    rag_ready=false
    for _ in {1..30}; do
      if docker exec "$rag_container" node -e \
        "fetch('http://127.0.0.1:18192/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"; then
        rag_ready=true
        break
      fi
      sleep 0.1
    done
    if [[ "$rag_ready" != true ]]; then
      echo "MCP RAG mock did not become ready" >&2
      docker logs "$rag_container" >&2 || true
      exit 1
    fi
    just test-rebuild
    export PLAYWRIGHT_BASE_URL="$AUTH_URL"
    export PLAYWRIGHT_DATABASE_URL="postgresql://besedy_test:besedy_test@127.0.0.1:${mcp_db_port}/besedy_test"
    echo "Waiting for rebuilt MCP test server..."
    for i in {1..60}; do
      if curl -sf "$PLAYWRIGHT_BASE_URL/api/health" > /dev/null 2>&1; then
        cd web
        npm run test:e2e:mcp
        exit 0
      fi
      sleep 1
    done
    echo "MCP test server did not become ready at $PLAYWRIGHT_BASE_URL" >&2
    exit 1
