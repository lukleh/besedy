#!/usr/bin/env bash
#
# Compare a web env file's key names with the variables its Compose files use
# and with its env template. Only key names are ever printed, never values.
#
# Usage:
#   docker compose ... config --variables --format json \
#     | check_web_env_keys.sh <missing|unknown|report> <mode> <env-file> <template> <provided-names>
#
# The variables come from Compose itself, so this script never decides on its
# own whether an env file is usable; Compose does.
#
# missing: list the variables Compose marks required that the env file appears
#          not to set. Run after Compose has already failed, as a hint.
# unknown: warn about keys that neither the Compose files nor the template use.
# report:  print the full comparison, including optional template keys that
#          are not set; exit non-zero only when required keys appear missing.
#
# missing and unknown are advisory and always exit 0.
#
# provided-names is a space-separated list of variables the caller supplies
# itself (the wrapper's clean environment), which never count as missing or
# unknown.
#
# "Appears not to set" follows Compose's env-file rules closely but not
# exactly: a value that is empty after quotes and an inline comment are
# removed counts as unset, and so does a value made only of references such as
# ${OTHER}, which is empty whenever OTHER is. Compose does not distinguish
# ${VAR:?} from ${VAR?} in its variable list, so both are treated as needing a
# non-empty value.

set -euo pipefail

action="${1:-}"
case "$action" in
  missing | unknown | report) ;;
  *)
    echo "Usage: $0 <missing|unknown|report> <mode> <env-file> <template> <provided-names>" >&2
    exit 2
    ;;
esac
if (( $# != 5 )); then
  echo "Usage: $0 <missing|unknown|report> <mode> <env-file> <template> <provided-names>" >&2
  exit 2
fi
mode="$2" env_file="$3" template="$4" provided="$5"
variables="$(cat)"

# Key names assigned in an env file, one per line. With "set", only keys whose
# last assignment has a value that is not empty or made only of references.
# Lines inside a multi-line quoted value are part of that value, not keys.
env_keys() {
  awk -v want="${2:-any}" '
    function mark(name, value, quote) {
      seen[name] = 1
      if (value == "") { set[name] = 0; return }
      # Single quotes are literal; elsewhere a value made only of references
      # is empty whenever they are.
      if (quote != "\047" && value ~ /^(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)+$/) {
        set[name] = 0
        return
      }
      set[name] = 1
    }
    # Position of the closing quote in s, or 0; double quotes may be escaped.
    function closing(s, quote,    i, c) {
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (quote == "\"" && c == "\\") { i++; continue }
        if (c == quote) return i
      }
      return 0
    }
    open != "" {
      if (closing($0, open)) open = ""
      next
    }
    /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      line = $0
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      eq = index(line, "=")
      name = substr(line, 1, eq - 1)
      sub(/[[:space:]]+$/, "", name)
      raw = substr(line, eq + 1)
      value = raw
      sub(/^[[:space:]]+/, "", value)
      quote = substr(value, 1, 1)
      if (quote == "\"" || quote == "\047") {
        rest = substr(value, 2)
        end = closing(rest, quote)
        if (end == 0) {
          # The value continues on the next lines, so it is not empty.
          open = quote
          mark(name, "multi-line", quote)
          next
        }
        # Anything after the closing quote is an inline comment.
        mark(name, substr(rest, 1, end - 1), quote)
        next
      }
      # An unquoted value ends where a # follows whitespace, even right
      # after the = sign.
      value = raw
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      mark(name, value, "")
    }
    END {
      for (name in seen) if (want == "any" || set[name]) print name
    }
  ' "$1" | LC_ALL=C sort -u
}

# Key names a template mentions, including commented-out optional keys.
template_keys() {
  awk '
    /^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      line = $0
      sub(/^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?/, "", line)
      name = substr(line, 1, index(line, "=") - 1)
      sub(/[[:space:]]+$/, "", name)
      print name
    }
  ' "$1" | LC_ALL=C sort -u
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
any_keys="$(env_keys "$env_file")"
set_keys="$(env_keys "$env_file" set)"

required_missing="$(minus "$(minus "$required_names" "$provided_names")" "$set_keys")"
unknown="$(minus "$any_keys" "$(sorted "$(template_keys "$template")" "$compose_names" "$provided_names")")"

case "$action" in
  missing)
    if [[ -n "$required_missing" ]]; then
      cat >&2 <<EOF
The $mode env file appears to lack keys its Compose files require: $(join_words "$required_missing")
  env file: $env_file
  compare with: $template
EOF
    fi
    ;;
  unknown)
    if [[ -n "$unknown" ]]; then
      cat >&2 <<EOF
Warning: the $mode env file sets keys no Compose file or the template uses (renamed or removed?): $(join_words "$unknown")
  env file: $env_file
  compare with: $template
EOF
    fi
    ;;
  report)
    unset_optional="$(minus "$(minus "$(env_keys "$template")" "$any_keys")" "$(sorted "$required_missing" "$provided_names")")"
    echo "Env file: $env_file"
    echo "Template: $template"
    echo "Missing required keys: $(words_or_none "$required_missing")"
    echo "Optional template keys not set: $(words_or_none "$unset_optional")"
    echo "Keys no Compose file or the template uses: $(words_or_none "$unknown")"
    if [[ -n "$required_missing" ]]; then
      exit 1
    fi
    ;;
esac
