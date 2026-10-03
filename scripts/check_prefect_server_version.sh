#!/usr/bin/env bash
# Compare the Prefect server a host would start (or is running) with the
# prefect== client pin in pyproject.toml.
#
# Usage: check_prefect_server_version.sh [--running]
#
# Without --running, resolve the server image through `docker compose config`,
# so a PREFECT_IMAGE override in the host env file is seen, and fail when its
# tag differs from the pin. With --running, also ask the running prefect-server
# container for its version and fail when that differs. Compose and CLI errors
# are shown, not turned into "not running".
#
# BESEDY_ALLOW_PREFECT_VERSION_DRIFT=1 downgrades a mismatch to a warning, for
# a deliberate pin of a different server version.

set -euo pipefail

check_running=0
case "${1:-}" in
  "") ;;
  --running) check_running=1 ;;
  *)
    echo "Usage: $0 [--running]" >&2
    exit 2
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

pin="$(sed -nE 's/^[[:space:]]*"prefect(\[[^]"]*\])?==([0-9]+\.[0-9]+\.[0-9]+)".*/\2/p' pyproject.toml | head -n 1)"
if [[ -z "$pin" ]]; then
  echo "No prefect==X.Y.Z pin found in pyproject.toml" >&2
  exit 1
fi

env_file="$(bash scripts/resolve_jobs_env_file.sh prefect)"
compose=(docker compose --env-file "$env_file" -f jobs-service/docker-compose.prefect.yml)

# The image of the prefect-server service as compose resolves it, so a
# PREFECT_IMAGE override (any registry, tag or digest) is what gets checked.
image="$("${compose[@]}" config | awk '
  /^  prefect-server:/ { in_service = 1; next }
  in_service && /^  [^ ]/ { in_service = 0 }
  in_service && $1 == "image:" { print $2; exit }
')"
if [[ -z "$image" ]]; then
  echo "No prefect-server image found in the resolved compose config" >&2
  exit 1
fi
# prefecthq/prefect:3.8.7-python3.13 -> 3.8.7. Anything else (a digest, a
# prerelease or custom tag, `latest`) has no version we can compare.
image_version=""
if [[ "${image##*:}" =~ ^([0-9]+\.[0-9]+\.[0-9]+)(-python[0-9.]+)?$ ]]; then
  image_version="${BASH_REMATCH[1]}"
fi

echo "Prefect client pin (pyproject.toml): $pin"
echo "Prefect server image (resolved):     $image"

status=0
if [[ "$image_version" != "$pin" ]]; then
  echo "MISMATCH: resolved server image $image is not client pin $pin (X.Y.Z or X.Y.Z-pythonN.N)." >&2
  echo "  Unset PREFECT_IMAGE in $env_file to use the compose default." >&2
  status=1
fi

if [[ "$check_running" == 1 ]]; then
  if ! running="$("${compose[@]}" exec -T prefect-server prefect --version | head -n 1 | tr -d '[:space:]')"; then
    echo "Could not query the running prefect-server container (see the error above)." >&2
    exit 1
  fi
  echo "Prefect server (running):            $running"
  if [[ "$running" != "$pin" ]]; then
    echo "MISMATCH: running server $running does not match client pin $pin." >&2
    status=1
  fi
fi

if [[ "$status" != 0 && "${BESEDY_ALLOW_PREFECT_VERSION_DRIFT:-}" == "1" ]]; then
  echo "WARNING: continuing because BESEDY_ALLOW_PREFECT_VERSION_DRIFT=1." >&2
  status=0
fi
exit "$status"
