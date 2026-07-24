#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: run_worker.sh <command> [args...]" >&2
    exit 2
fi

command="$1"
shift

export PYTHONPATH="/workspace/besedy${PYTHONPATH:+:${PYTHONPATH}}"
export TMPDIR="${TMPDIR:-/tmp}"
export TMP="${TMP:-$TMPDIR}"
export TEMP="${TEMP:-$TMPDIR}"
export TORCH_EXTENSIONS_DIR="${TORCH_EXTENSIONS_DIR:-/data/torch/extensions}"

mkdir -p "$TMPDIR" "$TORCH_EXTENSIONS_DIR"
chmod 1777 "$TMPDIR" || true

status=0
set +e
python -m besedy.lib.rag_colbert_runtime.worker "$command" "$@"
status=$?
set -e

bundle_dir="${BESEDY_COLBERT_BUNDLE_DIR:-}"
host_uid="${BESEDY_COLBERT_CHOWN_UID:-}"
host_gid="${BESEDY_COLBERT_CHOWN_GID:-}"
if [[ "$(id -u)" == "0" && -n "$bundle_dir" && -e "$bundle_dir" && -n "$host_uid" && -n "$host_gid" ]]; then
    chown -R "${host_uid}:${host_gid}" "$bundle_dir" || true
fi

exit "$status"
