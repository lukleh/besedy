#!/usr/bin/env bash
# Report which top-level directories of the generic project snapshot grew the
# most, by file count, between the oldest and newest daily snapshot.
#
# File count (not bytes) is what drives the hard-link-preserving remote sync
# time, so this is the list to look at when the sync gets slow. Hard links are
# counted under every directory that holds one (du -l): rsync -H walks each
# top-level path in full, and without -l a shared inode (uv links .venv files
# to its cache) would be charged to whichever sibling du visited first, making
# the per-directory numbers depend on directory order.
#
# Configuration (ops.env or environment):
#   PROJECT_SNAPSHOT_ROOT  - rsnapshot root of the generic project backup (required)
#   PROJECT_SNAPSHOT_LABEL - backup label inside each snapshot (default: projects)
#   GROWTH_REPORT_LIMIT    - number of directories to list (default: 10)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

OPS_ENV_FILE="$("$PROJECT_DIR/scripts/resolve_ops_env_file.sh")"
if [ -f "$OPS_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$OPS_ENV_FILE"
    set +a
fi

: "${PROJECT_SNAPSHOT_ROOT:?is not set — add it to ops.env (see web/setup/backup/ops.env.example)}"
PROJECT_SNAPSHOT_LABEL="${PROJECT_SNAPSHOT_LABEL:-projects}"
GROWTH_REPORT_LIMIT="${GROWTH_REPORT_LIMIT:-10}"

case "$GROWTH_REPORT_LIMIT" in
    ''|*[!0-9]*|0)
        echo "GROWTH_REPORT_LIMIT must be a positive integer, got: $GROWTH_REPORT_LIMIT" >&2
        exit 1
        ;;
esac

# Print "<file count>\t<name>" for every top-level entry of a snapshot label dir.
count_top_level() {
    local dir="$1"
    local -a entries=()

    shopt -s nullglob dotglob
    entries=("$dir"/*)
    shopt -u nullglob dotglob
    [ "${#entries[@]}" -gt 0 ] || return 0

    du --inodes -s -l -- "${entries[@]}" 2>/dev/null | while IFS=$'\t' read -r count path; do
        printf '%s\t%s\n' "$count" "${path##*/}"
    done
}

# rsnapshot rotates daily.0 (newest) up to daily.N (oldest).
newest="$PROJECT_SNAPSHOT_ROOT/daily.0/$PROJECT_SNAPSHOT_LABEL"
oldest=""
oldest_index=0
for candidate in "$PROJECT_SNAPSHOT_ROOT"/daily.*; do
    index="${candidate##*/daily.}"
    case "$index" in
        ''|*[!0-9]*) continue ;;
    esac
    if [ "$index" -gt "$oldest_index" ] && [ -d "$candidate/$PROJECT_SNAPSHOT_LABEL" ]; then
        oldest_index="$index"
        oldest="$candidate/$PROJECT_SNAPSHOT_LABEL"
    fi
done

if [ ! -d "$newest" ] || [ -z "$oldest" ] || [ ! -d "$oldest" ]; then
    echo "Need at least two daily snapshots under $PROJECT_SNAPSHOT_ROOT to compare."
    exit 0
fi

snapshot_date() {
    date -r "$(dirname "$1")" '+%Y-%m-%d'
}

declare -A old_counts=()
while IFS=$'\t' read -r count name; do
    old_counts["$name"]="$count"
done < <(count_top_level "$oldest")

old_total=0
for name in "${!old_counts[@]}"; do
    old_total=$(( old_total + old_counts["$name"] ))
done

new_total=0
rows=""
while IFS=$'\t' read -r count name; do
    new_total=$(( new_total + count ))
    before="${old_counts[$name]:-0}"
    delta=$(( count - before ))
    [ "$delta" -gt 0 ] || continue
    note=""
    [ -n "${old_counts[$name]+x}" ] || note=" (new)"
    rows+="$delta"$'\t'"$before"$'\t'"$count"$'\t'"$name$note"$'\n'
done < <(count_top_level "$newest")

if [ "$old_total" -gt 0 ]; then
    total_growth="$(( (new_total - old_total) * 100 / old_total ))%"
else
    total_growth="n/a"
fi

echo "Files in $PROJECT_SNAPSHOT_LABEL/: $old_total ($(snapshot_date "$oldest")) -> $new_total ($(snapshot_date "$newest")), change $total_growth"
if [ -z "$rows" ]; then
    echo "No top-level directory grew."
    exit 0
fi

echo "Top growth by file count:"
printf '%s' "$rows" | sort -t$'\t' -k1,1nr | awk -v limit="$GROWTH_REPORT_LIMIT" 'NR <= limit' |
    while IFS=$'\t' read -r delta before count name; do
        printf '  %+10d  %10d -> %-10d  %s\n' "$delta" "$before" "$count" "$name"
    done
