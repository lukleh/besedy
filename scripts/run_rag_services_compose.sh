#!/usr/bin/env bash
# Run docker compose for rag-services/docker-compose.yml with the host env file.
#
# The ColBERT sidecar's COLBERT_PRELOAD_INDEX_DIR (and the optional path
# overrides) come from ~/.config/lukleh/besedy/rag-services.env, or the file
# BESEDY_RAG_SERVICES_ENV names, so a plain `just colbert-up` recreates the
# container with the same preload instead of an empty one. Template:
# rag-services/.env.example. The file is optional; without it the sidecar starts
# cold and says so.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

normalize_path() {
  if [[ "$1" = /* ]]; then
    printf '%s\n' "$1"
  else
    printf '%s\n' "$repo_root/$1"
  fi
}

override_value="${BESEDY_RAG_SERVICES_ENV:-}"
if [[ -n "$override_value" ]]; then
  env_file="$(normalize_path "$override_value")"
  if [[ ! -f "$env_file" ]]; then
    echo "BESEDY_RAG_SERVICES_ENV points to missing file: $env_file" >&2
    exit 1
  fi
else
  env_file="$(normalize_path "${XDG_CONFIG_HOME:-$HOME/.config}")/lukleh/besedy/rag-services.env"
fi

compose=(docker compose)
if [[ -f "$env_file" ]]; then
  compose+=(--env-file "$env_file")
elif [[ -z "${COLBERT_PRELOAD_INDEX_DIR:-}" ]]; then
  echo "Note: no rag-services env file at $env_file and COLBERT_PRELOAD_INDEX_DIR is unset;" >&2
  echo "      ColBERT starts without a preloaded index (copy rag-services/.env.example)." >&2
fi

cd "$repo_root"
exec "${compose[@]}" -f rag-services/docker-compose.yml "$@"
