#!/usr/bin/env bash
#
# Compare a web env file's key names with its env template, to show drift as
# the template changes. Only key names are ever read or printed, never values.
#
# Usage:
#   check_web_env_keys.sh <unknown|report> <mode> <env-file> <template> \
#     <compose-status> <compose-file>...
#
# unknown: warn about env-file keys that neither the template, the mode's
#          Compose files, nor another key of the same file uses; usually a
#          key that was renamed or removed. Always exits 0.
# report:  print that list and the template keys the env file does not set,
#          then exit non-zero if <compose-status> (the exit status of
#          Compose's own config check) is non-zero.
#
# Compose alone decides whether an env file is usable. This script does not
# say which keys are required: Compose names a missing required key itself,
# and many template keys are optional.
#
# Names come from plain KEY=value lines (optionally with "export "). Exotic
# dotenv syntax such as "KEY: value", or a line inside a multi-line quoted
# value that looks like an assignment, can make a name missed or invented;
# the lists are advisory and never fail a command.

set -euo pipefail

usage="Usage: $0 <unknown|report> <mode> <env-file> <template> <compose-status> <compose-file>..."
action="${1:-}"
case "$action" in
  unknown | report) ;;
  *)
    echo "$usage" >&2
    exit 2
    ;;
esac
if (( $# < 5 )); then
  echo "$usage" >&2
  exit 2
fi
mode="$2" env_file="$3" template="$4" compose_status="$5"
shift 5
compose_files=("$@")

# Names assigned in an env-format file. "all" also counts commented-out
# assignments ("# KEY=value"), which templates use for optional keys.
assigned_names() {
  local pattern='^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*='
  if [[ "${2:-}" == all ]]; then
    pattern='^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*='
  fi
  { grep -E "$pattern" "$1" || true; } \
    | sed -E 's/^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?//; s/[[:space:]]*=.*$//' \
    | LC_ALL=C sort -u
}

# Names referenced as $NAME or ${NAME in the given files. This
# over-approximates (a reference in a comment counts too), which only ever
# keeps a key off the advisory unknown list.
referenced_names() {
  { grep -ohE '\$\{?[A-Za-z_][A-Za-z0-9_]*' "$@" /dev/null || true; } \
    | sed -E 's/^\$\{?//' | LC_ALL=C sort -u
}

# Lines of $1 that are not lines of $2 (both sorted, one name per line).
minus() {
  LC_ALL=C comm -23 <(printf '%s\n' "$1" | sed '/^$/d') <(printf '%s\n' "$2" | sed '/^$/d')
}

words_or_none() {
  local words
  words="$(printf '%s\n' "$1" | sed '/^$/d' | tr '\n' ' ' | sed 's/ $//')"
  printf '%s\n' "${words:-none}"
}

env_names="$(assigned_names "$env_file")"
unknown="$(minus "$env_names" "$(
  {
    assigned_names "$template" all
    referenced_names ${compose_files[@]+"${compose_files[@]}"}
    referenced_names "$env_file"
  } | LC_ALL=C sort -u
)")"

case "$action" in
  unknown)
    if [[ -n "$unknown" ]]; then
      cat >&2 <<MSG
Warning: the $mode env file sets keys that neither its template, its Compose files, nor another key uses (renamed or removed?): $(words_or_none "$unknown")
  env file: $env_file
  compare with: $template
MSG
    fi
    ;;
  report)
    echo "Env file: $env_file"
    echo "Template: $template"
    if (( compose_status == 0 )); then
      echo "Compose: accepts this env file"
    else
      echo "Compose: rejects this env file (its error is above)"
    fi
    echo "Template keys the env file does not set (many are optional): $(words_or_none "$(minus "$(assigned_names "$template")" "$env_names")")"
    echo "Env file keys that neither the template, the Compose files, nor another key uses: $(words_or_none "$unknown")"
    if (( compose_status != 0 )); then
      exit 1
    fi
    ;;
esac
