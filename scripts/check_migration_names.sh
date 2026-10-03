#!/usr/bin/env bash
# Check that the migration directories this branch adds are named so that a
# fresh database applies them in the same order as production: a 14-digit
# timestamp, unique among the added migrations and later than every migration
# on the base branch. Prisma applies pending migrations in name order, so an
# older timestamp would run before migrations production applied first.
#
# Existing names are left alone: production has applied them under those names.
# For the same reason a migration on the base branch must not be renamed or
# deleted; Prisma would treat a renamed one as new and run its SQL again.
#
# Usage: check_migration_names.sh <base-ref>
set -euo pipefail

base_ref="${1:?usage: check_migration_names.sh <base-ref>}"
migrations_dir=web/prisma/migrations

cd "$(git rev-parse --show-toplevel)"

# sed rather than grep: it succeeds without matches, which pipefail needs.
timestamps() { sed -nE 's/^([0-9]{14})_.*/\1/p'; }

base_names=$(git ls-tree -d --name-only "$base_ref" "$migrations_dir/" | sed 's|.*/||' | sort)
head_names=$(for dir in "$migrations_dir"/*/; do
    if [[ -d "$dir" ]]; then basename "$dir"; fi
done | sort)
removed=$(comm -23 <(printf '%s\n' "$base_names") <(printf '%s\n' "$head_names") | sed '/^$/d')
added=$(comm -13 <(printf '%s\n' "$base_names") <(printf '%s\n' "$head_names") | sed '/^$/d')
failed=0

if [[ -n "$removed" ]]; then
    while IFS= read -r name; do
        echo "::error::$name: this migration is on $base_ref and production may have applied it. Restore it under this name; do not rename or delete it."
    done <<<"$removed"
    failed=1
fi

if [[ -z "$added" ]]; then
    echo "No migrations added."
    exit "$failed"
fi

latest_base=$(printf '%s\n' "$base_names" | timestamps | sort | tail -n 1)

while IFS= read -r name; do
    if [[ ! "$name" =~ ^[0-9]{14}_ ]]; then
        echo "::error::$name: the name must start with a 14-digit timestamp and an underscore"
        failed=1
    elif [[ ! "${name:0:14}" > "$latest_base" ]]; then
        echo "::error::$name: the timestamp must be later than $latest_base, the latest migration on $base_ref. Rename the directory to a current timestamp."
        failed=1
    fi
done <<<"$added"

duplicates=$(printf '%s\n' "$added" | timestamps | sort | uniq -d)
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
