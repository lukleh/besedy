# Besedy Web Application

Web interface for browsing and managing audio catalogs and transcripts.

## Prerequisites

- Docker and Docker Compose
- Node.js 20+ (for local development without Docker)

## Environment Configuration

The app uses a single `APP_ENV` variable to control runtime behavior:
- `development` - Development mode, no auth rate limiting
- `test` - E2E test mode, no auth rate limiting
- `production` - Real OAuth, full security hardening

## Development

Development runs on **port 3001** with hot reload enabled.

For local Node.js development and checks, install the locked dependencies:

```bash
npm ci
npm run check
npm run test
```

The normal development, build, type-check, and test commands generate the
ignored Prisma client automatically from `prisma/schema.prisma`, so a fresh
checkout does not need to carry generated files.

```bash
# Start development environment
docker compose --env-file "$(../scripts/resolve_web_env_file.sh development)" --profile mock-oauth up -d

# View logs
docker compose --env-file "$(../scripts/resolve_web_env_file.sh development)" --profile mock-oauth logs -f web

# Shell into container
docker compose --env-file "$(../scripts/resolve_web_env_file.sh development)" --profile mock-oauth exec web sh

# Stop (keeps data)
docker compose --env-file "$(../scripts/resolve_web_env_file.sh development)" --profile mock-oauth down
```

Or use just commands:
```bash
just dev-up          # Start
just dev-logs        # View logs
just dev-shell       # Shell access
just dev-down        # Stop
```

### Database Operations

```bash
# Open Prisma Studio (DB GUI on port 5555)
docker compose --env-file "$(../scripts/resolve_web_env_file.sh development)" exec web npx prisma studio

# Run pending migrations
docker compose --env-file "$(../scripts/resolve_web_env_file.sh development)" exec web npx prisma migrate deploy

# Create new migration after schema changes
docker compose --env-file "$(../scripts/resolve_web_env_file.sh development)" exec web npx prisma migrate dev --name <migration_name>

# Reset database (WARNING: deletes all data)
docker compose --env-file "$(../scripts/resolve_web_env_file.sh development)" exec web npx prisma migrate reset --force
```

### Database Migrations Workflow

All schema changes go through Prisma migrations:

1. **Modify schema**: Edit `prisma/schema.prisma`
2. **Create migration**: `npx prisma migrate dev --name descriptive_name`
3. **Test in dev**: Verify changes work correctly
4. **Apply to prod**: `npx prisma migrate deploy` (or via SQL for prod)

**Production migrations** require the migrator user credentials:
```bash
# Apply migrations to production
docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$(../scripts/resolve_web_env_file.sh production)" exec -T db \
  psql -U besedy_migrator -d besedy < prisma/migrations/<migration_dir>/migration.sql

# Then register in migrations table
docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$(../scripts/resolve_web_env_file.sh production)" exec db \
  psql -U besedy_migrator -d besedy -c "INSERT INTO _prisma_migrations ..."
```

**Never use `db push` in production** - always use migrations for reproducibility.

### Audio File Access

Audio and data paths are configured in the resolved development env file
(`BESEDY_WEB_ENV_DEV` or `~/.config/lukleh/besedy/web.env.dev`). See
`.env.dev.example` for the template.

## Production

Production runs on **port 3000** with an optimized standalone build.

For exposing to the internet via Cloudflare Tunnel, see [docs/web/operations.md](../docs/web/operations.md).

### Initial Setup

```bash
# Create production config from template
mkdir -p ~/.config/lukleh/besedy
cp .env.prod.example ~/.config/lukleh/besedy/web.env.prod
cp besedy.container.toml.example ~/.config/lukleh/besedy/besedy.container.toml
chmod 644 ~/.config/lukleh/besedy/besedy.container.toml

# Edit with actual values:
# - CONFIG_FILE: the absolute path to the external besedy.container.toml above
# - APP_ENV=production
# - POSTGRES_PASSWORD: strong password
# - AUTH_SECRET: random 32-byte secret (openssl rand -base64 32)
# - AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET: required for production sign-in
# - TEXT_DATA_DIR: path to catalogs and transcripts
# - AUDIO_DIR: path to audio files
# - AUTH_URL: your production URL (required for OAuth)
```

Existing installations that switch the default Faster-Whisper workflow to
automatic language detection must also set
`RAG_BACKEND_KEY=faster-whisper/large-v3@silero_vad_v6@lang-auto`. This keeps
web search and transcript export pointed at the language-aware transcript tree.

### Deploy

```bash
just prod-deploy     # Full deploy with migrations
just prod-up         # Start (assumes already built)
just prod-rebuild    # Rebuild and restart
```

These commands validate the external config bind before Docker can create or
replace containers. Use `prod-deploy` for releases; it rebuilds the image from
the current code and applies database migrations. Production builds must use a
clean tracked `web/` tree. Deployment derives a stable `WEB_VERSION` from
production web inputs and browser-visible build configuration, so unrelated
repository commits and web-only tests or documentation do not prompt installed
clients to update.

### Production Services

| Service | Description |
|---------|-------------|
| `web` | Next.js application (port 3000) |
| `db` | PostgreSQL 18 (internal only, not exposed) |
| `backup` | Daily database backups (keeps last 7) |
| `scanner` | Triggers catalog scan for new recordings |

### Managing Production

```bash
# View logs
docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$(../scripts/resolve_web_env_file.sh production)" logs -f web

# View persisted daily web logs (host bind mount)
tail -F "${WEB_LOGS_DIR}/web-$(date +%F).log"

# Restart after config changes
docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$(../scripts/resolve_web_env_file.sh production)" restart web

# Access database directly
docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$(../scripts/resolve_web_env_file.sh production)" exec db psql -U besedy

# Stop production
docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$(../scripts/resolve_web_env_file.sh production)" down
```

Or use just commands:
```bash
just prod-logs       # View logs
just prod-restart    # Restart web
just prod-db         # Database shell
just prod-down       # Stop
```

### Backups

Backups are stored in `${BACKUP_DIR}` (default: `${HOME}/.local/state/lukleh/besedy/web/backups`). The backup service:
- Runs daily
- Creates timestamped `.sql.gz` files
- Retains the last 7 backups

Web application logs are stored in `${WEB_LOGS_DIR}` as daily files:
- `web-YYYY-MM-DD.log`
- Rotates automatically at midnight (new file per day)
- Kept indefinitely unless you prune them manually

Before first start, ensure `${WEB_LOGS_DIR}` exists and is writable by container UID `1001`:
```bash
mkdir -p /path/to/web/logs
sudo chown -R 1001:1001 /path/to/web/logs
```

To restore:
```bash
gunzip -c backups/besedy_YYYYMMDD_HHMMSS.sql.gz | \
  docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$(../scripts/resolve_web_env_file.sh production)" exec -T db psql -U besedy
```

## Running Both Environments

Development and production can run simultaneously on the same machine:

| Environment | Web Port | DB Port | Containers |
|-------------|----------|---------|------------|
| Development | 3001 | 5433 | `besedy-development-*` |
| Test (E2E) | 3002 | 5434 | `besedy-test-*` |
| Production | 3000 | (internal) | `besedy-production-*` |

## Testing

### Unit Tests (Vitest)

```bash
npm run test              # Run once
npm run test:watch        # Watch mode
npm run test:coverage     # With coverage
```

### E2E Tests (Playwright)

E2E tests run against a production build in an isolated Docker environment on port 3002.
The test runner handles container startup, DB seeding, and fixture generation automatically.

```bash
npm run test:e2e          # Run tests (headless) - starts containers if needed
npm run test:e2e:ui       # Interactive UI mode
npm run test:e2e:headed   # With visible browser
npm run test:e2e:teardown # Stop containers (keeps data)
npm run test:e2e:teardown:clean  # Stop and delete volumes
```

Or use just commands:
```bash
just test-up         # Start test environment
just test-down       # Stop
just test-down-clean # Stop and delete volumes
```

## Environment Files

| File | Purpose |
|------|---------|
| `~/.config/lukleh/besedy/web.env.dev` | Preferred development env file |
| `.env.dev.example` | Template for development config |
| `~/.config/lukleh/besedy/web.env.test` | Preferred test env file |
| `.env.test.example` | Template for test config |
| `~/.config/lukleh/besedy/web.env.prod` | Preferred production env file |
| `.env.prod.example` | Template for production config |
| `.env.local` | Next.js local overrides (gitignored) |

## Docker Compose Structure

The app uses a unified `docker-compose.yml` with profiles:

```bash
# Development (hot reload)
docker compose --env-file "$(../scripts/resolve_web_env_file.sh development)" --profile mock-oauth up -d

# Test (security hardening)
docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$(../scripts/resolve_web_env_file.sh test)" --profile mock-oauth up -d

# Production (real OAuth, full security, backup services)
docker compose -f docker-compose.yml -f docker-compose.secure.yml --env-file "$(../scripts/resolve_web_env_file.sh production)" --profile backup up -d
```

### Profiles

| Profile | Services | Used By |
|---------|----------|---------|
| `mock-oauth` | Mock OAuth provider | dev, test |
| `tools` | pgAdmin | dev (optional) |
| `backup` | Backup scheduler, scanner | prod |
