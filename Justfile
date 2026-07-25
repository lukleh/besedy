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

rag-services-up:
    {{ rag_services_compose }} up -d

rag-services-down:
    {{ rag_services_compose }} down

rag-services-logs:
    {{ rag_services_compose }} logs -f

embeddings-up:
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

colbert-up:
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

jobs-dev-up:
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

jobs-test-up:
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

jobs-prod-up:
    just prefect-up
    {{ ensure_internal_network }}
    {{ ensure_prefect_network }}
    just jobs-prod-build
    {{ jobs_prod_compose }} up -d --no-build

# Start production with the narrowly scoped Codex auth overlay for
# model-chatgpt-* profiles.
jobs-prod-up-codex:
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
    {{ jobs_prod_compose }} build --pull \
        --build-arg RLMBENCHY_REFRESH="$(date +%s)" \
        jobs-api
    echo "Built production jobs image for commit ${GIT_COMMIT:0:12}"

jobs-prod-down:
    {{ jobs_prod_compose }} down

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
# Web App - Development (port 3001)
# ============================================================================

# Dev compose command (with source mount for hot reloading)
dev_compose := "bash ../scripts/run_web_compose.sh development"
prod_compose := "bash ../scripts/run_web_compose.sh production"
test_compose := "bash ../scripts/run_web_compose.sh test"

# Start dev environment (detached)
dev-up:
    {{ ensure_internal_network }}
    cd web && {{ dev_compose }} up -d

# Start dev with pgAdmin
dev-up-tools:
    {{ ensure_internal_network }}
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
    cd web && {{ dev_compose }} up -d --build web

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
    {{ ensure_internal_network }}
    cd web
    export GIT_COMMIT=$(git rev-parse HEAD)
    export BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
    {{ prod_compose }} up -d --remove-orphans

# Stop prod environment (keeps data)
prod-down:
    cd web && {{ prod_compose }} down

# Stop prod and delete volumes (DESTRUCTIVE - deletes database!)
prod-down-clean:
    cd web && {{ prod_compose }} down -v

# Restart web container
prod-restart:
    cd web && {{ prod_compose }} restart web

# Rebuild with version tracking
prod-rebuild:
    #!/usr/bin/env bash
    set -euo pipefail
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
    export BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
    docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$env_file" --profile backup build --pull --no-cache web
    docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$env_file" --profile backup up -d web

# Full production deployment: build, migrate, restart
prod-deploy:
    #!/usr/bin/env bash
    set -euo pipefail
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
    require_env VAPID_PRIVATE_KEY
    if [ "$NEXT_PUBLIC_APP_URL" != "$AUTH_URL" ]; then
        echo "NEXT_PUBLIC_APP_URL must match AUTH_URL for production"
        exit 1
    fi
    echo "Building production with version tracking..."
    export GIT_COMMIT=$(git rev-parse HEAD)
    export BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
    docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$env_file" --profile backup build --pull --no-cache web
    echo "Starting production services..."
    docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$env_file" --profile backup up -d --no-build --remove-orphans web
    echo "Running migrations..."
    just prod-migrate
    echo "Restarting web service..."
    docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$env_file" restart web
    echo "Deployment complete. Commit: ${GIT_COMMIT:0:7}"
    echo "Verify: curl -s http://localhost:3000/api/version | jq"

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
    docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$env_file" exec -T db \
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
    {{ ensure_internal_network }}
    cd web

    # Start containers
    echo "Starting test containers..."
    {{ test_compose }} up -d

    # Wait for DB to be ready
    echo "Waiting for database..."
    for i in {1..30}; do
      if {{ test_compose }} exec -T db pg_isready -U besedy_test > /dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    # Always reset DB for fresh state
    echo "Resetting database..."
    {{ test_compose }} exec -T db \
      psql -U besedy_test -d besedy_test -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" > /dev/null

    echo "Applying migrations..."
    DATABASE_URL=postgresql://besedy_test:besedy_test@localhost:5434/besedy_test npx prisma migrate deploy

    echo "Seeding test data..."
    DATABASE_URL=postgresql://besedy_test:besedy_test@localhost:5434/besedy_test npx tsx prisma/seed-test.ts

    # Wait for web server
    echo "Waiting for web server..."
    for i in {1..60}; do
      if curl -sf http://localhost:3002/api/health > /dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    echo "Test environment ready on port 3002"

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
    if ! {{ test_compose }} exec -T db pg_isready -U besedy_test > /dev/null 2>&1; then
      echo "Database not ready"
      exit 1
    fi

    # Check web ready
    if ! curl -sf http://localhost:3002/api/health > /dev/null; then
      echo "Web server not ready"
      exit 1
    fi

    echo "Test environment ready"
