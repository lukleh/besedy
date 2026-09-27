#!/usr/bin/env bash
#
# Explain how a web env file's keys line up with the variables its Compose
# files use and with its env template. Only key names are ever printed, never
# values.
#
# Usage:
#   docker compose ... config --variables --format json \
#     | check_web_env_keys.sh <missing|unknown|report> <mode> <env-file> \
#         <template> <provided-names> <facts> [<compose-status> [<error-names>]]
#
# Compose decides whether an env file is usable, and it also parses the env
# file for this script: <facts> holds "NAME=set" or "NAME=empty" for every key
# the file sets, as Compose's own dotenv parser reads it (the caller loads the
# file as a minimal service's env_file). This script never parses values.
#
# missing: list the variables Compose marks required that the env file leaves
#          unset or empty. Run after Compose has already failed, as a hint.
# unknown: warn about keys that neither the Compose files, the template, nor
#          another key in the same file uses.
# report:  print the full comparison. Exits non-zero only when <compose-status>
#          (the exit status of Compose's own config check) is non-zero.
#
# missing and unknown are advisory and always exit 0.
#
# provided-names is a space-separated list of variables the caller supplies
# itself (the wrapper's clean environment), which never count as missing or
# unknown. error-names lists the variables Compose's own error named as missing
# ("required variable NAME is missing a value"); they are always listed as
# missing, whatever the variable list says.
#
# Compose before 2.40 cannot list the variables of these Compose files (it
# rejects `${VAR:-default}:/path:ro` volume specs in `config --variables`).
# When stdin is not a JSON object, the lists fall back to error-names, say
# that the full list needs a newer Compose, and skip the unknown-key check,
# which would otherwise flag keys only the Compose files use.
#
# Compose does not distinguish ${VAR:?} from ${VAR?} in its variable list, so
# the lists call a required key "missing or empty": an empty value is
# accepted by ${VAR?}. Compose's verdict, not these lists, decides the exit
# status.

set -euo pipefail

usage="Usage: $0 <missing|unknown|report> <mode> <env-file> <template> <provided-names> <facts> [<compose-status> [<error-names>]]"
action="${1:-}"
case "$action" in
  missing | unknown | report) ;;
  *)
    echo "$usage" >&2
    exit 2
    ;;
esac
if (( $# < 6 || $# > 8 )); then
  echo "$usage" >&2
  exit 2
fi
mode="$2" env_file="$3" template="$4" provided="$5" facts="$6" compose_status="${7:-0}"
error_names="${8:-}"
variables="$(cat)"
variables_listed=true
if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$variables"; then
  variables_listed=false
  variables="{}"
fi
newer_compose_note="this Compose version cannot list every variable its files require; Compose 2.40 or newer can"

# Key names a template mentions: "all" includes commented-out optional keys,
# "active" only the keys it assigns. Templates are checked into this repo.
template_keys() {
  local pattern='^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*='
  if [[ "$2" == all ]]; then
    pattern='^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*='
  fi
  grep -E "$pattern" "$1" \
    | sed -E 's/^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?//; s/[[:space:]]*=.*$//' \
    | LC_ALL=C sort -u || true
}

# Names referenced as $NAME or ${NAME anywhere in the env file. This
# over-approximates (a reference in a comment or single quotes counts too),
# which only ever keeps a key off the advisory unknown list.
referenced_names() {
  { grep -oE '\$\{?[A-Za-z_][A-Za-z0-9_]*' "$1" || true; } \
    | sed -E 's/^\$\{?//' | LC_ALL=C sort -u
}

# Names from <facts> with the given state ("set", "empty"), or all of them.
fact_names() {
  printf '%s\n' "$facts" | tr ' ' '\n' | sed '/^$/d' \
    | awk -F= -v want="$1" 'want == "any" || $2 == want { print $1 }' \
    | LC_ALL=C sort -u
}

# Lines of $1 that are not lines of $2 (both sorted, one name per line).
minus() {
  LC_ALL=C comm -23 <(printf '%s\n' "$1" | sed '/^$/d') <(printf '%s\n' "$2" | sed '/^$/d')
}

sorted() {
  printf '%s\n' "$@" | sed '/^$/d' | LC_ALL=C sort -u
}

join_words() {
  printf '%s\n' "$1" | sed '/^$/d' | tr '\n' ' ' | sed 's/ $//'
}

words_or_none() {
  local words
  words="$(join_words "$1")"
  printf '%s\n' "${words:-none}"
}

provided_names="$(printf '%s\n' "$provided" | tr ' ' '\n' | sed '/^$/d' | LC_ALL=C sort -u)"
compose_names="$(jq -r 'keys[]' <<<"$variables" | LC_ALL=C sort -u)"
required_names="$(jq -r 'to_entries[] | select(.value.Required) | .key' <<<"$variables" | LC_ALL=C sort -u)"
set_keys="$(fact_names set)"

named_missing="$(printf '%s\n' "$error_names" | tr ' ' '\n' | sed '/^$/d' | LC_ALL=C sort -u)"

required_missing() {
  minus "$(sorted "$(minus "$required_names" "$set_keys")" "$named_missing")" "$provided_names"
}

unknown_keys() {
  [[ "$variables_listed" == true ]] || return 0
  minus "$(fact_names any)" "$(sorted "$(template_keys "$template" all)" "$compose_names" \
    "$provided_names" "$(referenced_names "$env_file")")"
}

case "$action" in
  missing)
    missing="$(required_missing)"
    if [[ -n "$missing" ]]; then
      cat >&2 <<EOF
The $mode env file leaves unset or empty keys its Compose files require: $(join_words "$missing")
  env file: $env_file
  compare with: $template
EOF
      if [[ "$variables_listed" == false ]]; then
        echo "  ($newer_compose_note)" >&2
      fi
    fi
    ;;
  unknown)
    unknown="$(unknown_keys)"
    if [[ -n "$unknown" ]]; then
      cat >&2 <<EOF
Warning: the $mode env file sets keys no Compose file, the template, or another key uses (renamed or removed?): $(join_words "$unknown")
  env file: $env_file
  compare with: $template
EOF
    fi
    ;;
  report)
    missing="$(required_missing)"
    unset_optional="$(minus "$(template_keys "$template" active)" "$(sorted "$set_keys" "$missing" "$provided_names")")"
    echo "Env file: $env_file"
    echo "Template: $template"
    if (( compose_status == 0 )); then
      echo "Compose: accepts this env file"
    else
      echo "Compose: rejects this env file (see: bash scripts/run_web_compose.sh $mode config --quiet)"
    fi
    echo "Missing or empty required keys: $(words_or_none "$missing")"
    echo "Optional template keys not set: $(words_or_none "$unset_optional")"
    if [[ "$variables_listed" == true ]]; then
      echo "Keys no Compose file, the template, or another key uses: $(words_or_none "$(unknown_keys)")"
    else
      echo "Keys no Compose file, the template, or another key uses: not checked"
      echo "Note: $newer_compose_note."
    fi
    if (( compose_status != 0 )); then
      exit 1
    fi
    ;;
esac
