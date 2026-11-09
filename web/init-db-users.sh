#!/bin/bash
set -e

# Runs on fresh DB init (docker-entrypoint-initdb.d)
# Env vars MIGRATE_PASSWORD and APP_PASSWORD from docker-compose

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Migrator: full DDL for schema changes (used from host only)
    CREATE USER besedy_migrator WITH PASSWORD '$MIGRATE_PASSWORD';
    GRANT ALL PRIVILEGES ON DATABASE $POSTGRES_DB TO besedy_migrator;
    GRANT ALL PRIVILEGES ON SCHEMA public TO besedy_migrator;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL PRIVILEGES ON TABLES TO besedy_migrator;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL PRIVILEGES ON SEQUENCES TO besedy_migrator;

    -- App: DML only for runtime (used by container)
    CREATE USER besedy_app WITH PASSWORD '$APP_PASSWORD';
    GRANT CONNECT ON DATABASE $POSTGRES_DB TO besedy_app;
    GRANT USAGE ON SCHEMA public TO besedy_app;

    -- Future tables created by migrator get app permissions
    ALTER DEFAULT PRIVILEGES FOR USER besedy_migrator IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO besedy_app;
    ALTER DEFAULT PRIVILEGES FOR USER besedy_migrator IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO besedy_app;
EOSQL

echo "Created database users: besedy_migrator, besedy_app"
