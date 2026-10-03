#!/usr/bin/env bash
# Start the host ingest Prefect worker. This is the only place the start
# command is written: the systemd unit and `just ingest-worker-run` both call
# it, so the extras and flags cannot drift between production and development.
#
# Usage: run-worker.sh [--dev]
#
# Without --dev (the systemd unit) the caller supplies the environment, as the
# unit's EnvironmentFile does, and PREFECT_INGEST_WORK_POOL must be set so a
# missing env file can never start a worker on the wrong pool.
# --dev loads the same env file the way an operator shell would
# (BESEDY_INGEST_WORKER_ENV, default ~/.config/lukleh/besedy/ingest-worker.env)
# and defaults the pool to besedy-ingest-dev.

set -euo pipefail

dev=0
case "${1:-}" in
  "") ;;
  --dev) dev=1 ;;
  *)
    echo "Usage: $0 [--dev]" >&2
    exit 2
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/../.."

if [[ "$dev" == 1 ]]; then
  env_file="${BESEDY_INGEST_WORKER_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/lukleh/besedy/ingest-worker.env}"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  else
    echo "Ingest worker env file not found: $env_file (copy jobs-service/host-worker/ingest-worker.env.example)" >&2
  fi
  PREFECT_INGEST_WORK_POOL="${PREFECT_INGEST_WORK_POOL:-besedy-ingest-dev}"
fi
: "${PREFECT_INGEST_WORK_POOL:?PREFECT_INGEST_WORK_POOL must be set}"

# The checkout path is fixed in production, so the start line records the
# revision; a failed flow run in the journal can then be tied to it.
echo "besedy-ingest-worker: revision $(git rev-parse HEAD) in $(pwd)"

# `--frozen` keeps the venv on the committed lock. The `ml` extra supplies the
# tokenizer that `rag-colbert-index` needs for the ingest and correction-index
# flows.
exec uv run --frozen --extra jobs --extra ml prefect worker start \
  --pool "$PREFECT_INGEST_WORK_POOL" \
  --type process --limit 1 --install-policy never
