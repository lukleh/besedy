#!/usr/bin/env bash
# Restore a trusted Besedy dump in disposable RAM-backed PostgreSQL, never prod.
set -euo pipefail
umask 077

[ "$#" = 1 ] || { echo "Usage: $0 /path/to/besedy_TIMESTAMP.sql.gz" >&2; exit 2; }
archive="$(realpath -e "$1")"
[ -f "$archive" ] || { echo "Dump is not a regular file" >&2; exit 2; }
gzip -t "$archive"
image="${DB_RESTORE_TEST_IMAGE:-pgvector/pgvector:pg18}"
# Use an already installed image; do not fetch a new database version implicitly.
docker image inspect "$image" >/dev/null
container="besedy-db-restore-$(date -u +%Y%m%d%H%M%S)-$$"
created=0
cleanup() {
    if [ "$created" = 1 ]; then
        docker rm -f "$container" >/dev/null
    fi
}
trap cleanup EXIT

docker create --name "$container" --network none --memory 1g \
    --tmpfs /var/lib/postgresql:rw,size=1g --tmpfs /tmp:rw,size=64m \
    -e POSTGRES_USER=besedy -e POSTGRES_DB=besedy \
    -e POSTGRES_PASSWORD=disposable-restore-only "$image" >/dev/null
created=1
docker start "$container" >/dev/null
ready=0
for (( attempt=0; attempt<30; attempt++ )); do
    if docker exec "$container" pg_isready -q -U besedy -d besedy; then
        ready=1
        break
    fi
    sleep 1
done
[ "$ready" = 1 ] || { echo "Disposable PostgreSQL did not become ready" >&2; exit 1; }

docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U besedy -d besedy \
    -c 'CREATE ROLE besedy_app LOGIN; CREATE ROLE besedy_migrator LOGIN;'
gzip -cd "$archive" | docker exec -i "$container" \
    psql -X -v ON_ERROR_STOP=1 -U besedy -d besedy
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U besedy -d besedy \
    -c "SELECT count(*) AS public_tables FROM pg_tables WHERE schemaname='public';" \
    -c 'SELECT count(*) AS catalog_entries FROM public.catalog_entry;' \
    -c 'SELECT count(*) AS workflow_groups FROM public.workflow_group;' \
    -c 'SELECT count(*) AS migrations FROM public._prisma_migrations;' \
    -c 'SELECT extname, extversion FROM pg_extension ORDER BY extname;'
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U besedy_app -d besedy \
    -c 'SELECT count(*) AS catalog_entries_readable_by_app FROM public.catalog_entry;'
echo "RESTORE TEST PASSED: $archive"
sha256sum "$archive"
