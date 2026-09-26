#!/usr/bin/env bash
#
# Compare a web env file's key names with what the mode's Compose files and
# env template use. Only key names are ever printed, never values.
#
# Usage:
#   check_web_env_keys.sh check  <mode> <env-file> <template> <provided-names> <warn-unknown> <compose-file>...
#   check_web_env_keys.sh report <mode> <env-file> <template> <provided-names> <compose-file>...
#
# check:  fail listing every key the Compose files require (${VAR:?...} or
#         ${VAR?...}) that the env file lacks; with warn-unknown=true, also warn
#         about keys neither the Compose files nor the template mention.
# report: print the full comparison, including optional template keys that
#         are not set; exit non-zero only when required keys are missing.
#
# provided-names is a space-separated list of variables the caller supplies
# itself (for example the wrapper's clean environment), which never count as
# missing. A required reference nested inside another variable's default, such
# as ${A:-${B:?}}, only applies when A is unset, so it is not treated as
# required; no Compose file uses that form today.

set -euo pipefail

action="${1:-}"
case "$action" in
  check)
    if (( $# < 7 )); then
      echo "Usage: $0 check <mode> <env-file> <template> <provided-names> <warn-unknown> <compose-file>..." >&2
      exit 2
    fi
    mode="$2" env_file="$3" template="$4" provided="$5" warn_unknown="$6"
    shift 6
    ;;
  report)
    if (( $# < 6 )); then
      echo "Usage: $0 report <mode> <env-file> <template> <provided-names> <compose-file>..." >&2
      exit 2
    fi
    mode="$2" env_file="$3" template="$4" provided="$5" warn_unknown=true
    shift 5
    ;;
  *)
    echo "Usage: $0 <check|report> ..." >&2
    exit 2
    ;;
esac
compose_files=("$@")

# Key names assigned in an env file, one per line, parsed like the wrapper
# parses APP_ENV. With "nonempty", keys whose last assignment is empty are
# left out.
env_keys() {
  awk -v want="${2:-any}" '
    /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      line = $0
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      eq = index(line, "=")
      name = substr(line, 1, eq - 1)
      sub(/[[:space:]]+$/, "", name)
      value = substr(line, eq + 1)
      if (value !~ /^[[:space:]]*["\047]/) sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value == "\"\"" || value == "\047\047") value = ""
      set[name] = (value != "")
      seen[name] = 1
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

# Variables referenced anywhere in the Compose files (outside comment lines).
# With "required", only top-level ${VAR:?...} and ${VAR?...} references,
# printed as "NAME:" when an empty value also fails and "NAME" otherwise.
compose_refs() {
  local kind="$1"
  shift
  awk -v kind="$kind" '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      depth = 0
      n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (c == "$" && substr(line, i + 1, 1) == "$") { i++; continue }
        if (c == "$" && substr(line, i + 1, 1) == "{") {
          rest = substr(line, i + 2)
          if (match(rest, /^[A-Za-z_][A-Za-z0-9_]*/)) {
            name = substr(rest, 1, RLENGTH)
            op = substr(rest, RLENGTH + 1, 2)
            if (kind == "all") print name
            else if (depth == 0 && op == ":?") print name ":"
            else if (depth == 0 && substr(op, 1, 1) == "?") print name
          }
          depth++
          i++
          continue
        }
        if (c == "$" && kind == "all") {
          rest = substr(line, i + 1)
          if (match(rest, /^[A-Za-z_][A-Za-z0-9_]*/)) print substr(rest, 1, RLENGTH)
          continue
        }
        if (c == "}" && depth > 0) depth--
      }
    }
  ' "$@" | LC_ALL=C sort -u
}

# Lines of $1 that are not lines of $2 (both sorted, one name per line).
minus() {
  LC_ALL=C comm -23 <(printf '%s\n' "$1" | sed '/^$/d') <(printf '%s\n' "$2" | sed '/^$/d')
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
any_keys="$(env_keys "$env_file")"
set_keys="$(env_keys "$env_file" nonempty)"

required_refs="$(compose_refs required "${compose_files[@]}")"
required_missing=""
while IFS= read -r ref; do
  [[ -z "$ref" ]] && continue
  name="${ref%:}"
  if printf '%s\n' "$provided_names" | grep -qxF "$name"; then
    continue
  fi
  if [[ "$ref" == *: ]]; then
    printf '%s\n' "$set_keys" | grep -qxF "$name" && continue
  else
    printf '%s\n' "$any_keys" | grep -qxF "$name" && continue
  fi
  required_missing+="$name"$'\n'
done <<<"$required_refs"
required_missing="$(printf '%s' "$required_missing" | LC_ALL=C sort -u)"

known="$(
  { template_keys "$template"; compose_refs all "${compose_files[@]}"; printf '%s\n' "$provided_names"; } \
    | sed '/^$/d' | LC_ALL=C sort -u
)"
unknown="$(minus "$any_keys" "$known")"

if [[ "$action" == "report" ]]; then
  active_template="$(env_keys "$template")"
  unset_optional="$(minus "$(minus "$active_template" "$any_keys")" "$(printf '%s\n%s\n' "$required_missing" "$provided_names" | LC_ALL=C sort -u)")"
  echo "Env file: $env_file"
  echo "Template: $template"
  echo "Missing required keys: $(words_or_none "$required_missing")"
  echo "Optional template keys not set: $(words_or_none "$unset_optional")"
  echo "Keys no Compose file or the template uses: $(words_or_none "$unknown")"
  if [[ -n "$required_missing" ]]; then
    exit 1
  fi
  exit 0
fi

if [[ -n "$required_missing" ]]; then
  cat >&2 <<EOF
The $mode env file is missing keys its Compose files require: $(join_words "$required_missing")
  env file: $env_file
  compare with: $template
EOF
  exit 1
fi

if [[ "$warn_unknown" == true && -n "$unknown" ]]; then
  cat >&2 <<EOF
Warning: the $mode env file sets keys no Compose file or the template uses (renamed or removed?): $(join_words "$unknown")
  env file: $env_file
  compare with: $template
EOF
fi
