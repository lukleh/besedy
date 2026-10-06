#!/usr/bin/env bash
# Bridge names and creation for the Docker networks Besedy owns.
#
# The host egress policy (web/setup/egress/besedy-egress.nft) matches every
# interface named br-bsdy*, so each Besedy network must be created with such a
# bridge name. The name is fixed when the network is created; a network that
# already exists keeps its old br-<id> name until it is recreated.
#
# Usage:
#   docker_network.sh bridge-name <network>   print the bridge name for a network
#   docker_network.sh ensure <network>        create the network if it is missing
#
# Compose project networks (web, jobs, rag-services, backends) set the same
# names through driver_opts; this script covers the external shared networks
# and the per-instance web project network.

set -euo pipefail

bridge_name() {
  case "$1" in
    besedy-internal) echo "br-bsdy-int" ;;
    besedy-prefect) echo "br-bsdy-pfct" ;;
    besedy-production_default) echo "br-bsdy-wprod" ;;
    besedy-development_default) echo "br-bsdy-wdev" ;;
    besedy-test_default) echo "br-bsdy-wtest" ;;
    *)
      # Isolated test instances and overridden network names get a stable
      # 15-character name (the kernel limit). cksum is POSIX, so this also runs
      # on macOS.
      local crc
      crc="$(printf '%s' "$1" | cksum | awk '{print $1}')"
      printf 'br-bsdy-%07x\n' "$((crc & 0xfffffff))"
      ;;
  esac
}

ensure() {
  local network="$1" bridge current
  bridge="$(bridge_name "$network")"
  if current="$(docker network inspect --format '{{ index .Options "com.docker.network.bridge.name" }}' "$network" 2>/dev/null)"; then
    if [[ "$current" != br-bsdy* ]]; then
      echo "Warning: network $network was created without a br-bsdy* bridge name, so the egress policy does not cover it; recreate it (docs/web/egress-isolation.md)" >&2
    fi
    return 0
  fi
  docker network create --driver bridge --ipv6=false \
    --opt "com.docker.network.bridge.name=$bridge" "$network" >/dev/null \
    || docker network inspect "$network" >/dev/null
}

case "${1:-}" in
  bridge-name)
    [[ -n "${2:-}" ]] || { echo "Usage: $0 bridge-name <network>" >&2; exit 1; }
    bridge_name "$2"
    ;;
  ensure)
    [[ -n "${2:-}" ]] || { echo "Usage: $0 ensure <network>" >&2; exit 1; }
    ensure "$2"
    ;;
  *)
    echo "Usage: $0 <bridge-name|ensure> <network>" >&2
    exit 1
    ;;
esac
