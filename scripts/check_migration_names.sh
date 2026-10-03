#!/usr/bin/env bash
# Check that the migration directories this branch adds are named so that a
# fresh database applies them in the same order as production: a 14-digit
# timestamp, unique among the added migrations and later than every migration
# on the base branch. Prisma applies pending migrations in name order, so an
# older timestamp would run before migrations production applied first.
#
# Existing names are left alone: production has applied them under those names.
#
# Usage: check_migration_names.sh <base-ref>
set -euo pipefail

base_ref="${1:?usage: check_migration_names.sh <base-ref>}"
migrations_dir=web/prisma/migrations

cd "$(git rev-parse --show-toplevel)"

base_names=$(git ls-tree -d --name-only "$base_ref" "$migrations_dir/" | sed 's|.*/||' | sort)
head_names=$(find "$migrations_dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
added=$(comm -13 <(printf '%s\n' "$base_names") <(printf '%s\n' "$head_names"))

if [[ -z "$added" ]]; then
    echo "No migrations added."
    exit 0
fi

latest_base=$(printf '%s\n' "$base_names" | grep -oE '^[0-9]{14}' | sort | tail -n 1)
failed=0

while IFS= read -r name; do
    if [[ ! "$name" =~ ^[0-9]{14}_ ]]; then
        echo "::error::$name: the name must start with a 14-digit timestamp and an underscore"
        failed=1
    elif [[ ! "${name:0:14}" > "$latest_base" ]]; then
        echo "::error::$name: the timestamp must be later than $latest_base, the latest migration on $base_ref. Rename the directory to a current timestamp."
        failed=1
    fi
done <<<"$added"

duplicates=$(printf '%s\n' "$added" | grep -oE '^[0-9]{14}' | sort | uniq -d)
if [[ -n "$duplicates" ]]; then
    while IFS= read -r timestamp; do
        echo "::error::Several added migrations share the timestamp $timestamp"
    done <<<"$duplicates"
    failed=1
fi

if [[ "$failed" -eq 0 ]]; then
    echo "Added migrations are correctly named:"
    printf '  %s\n' $added
fi
exit "$failed"
