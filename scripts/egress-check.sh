#!/usr/bin/env bash
# Verify the container egress policy with real packets. See
# docs/web/egress-isolation.md.
#
# Run as root on the Docker host: sudo bash scripts/egress-check.sh [container...]
# With container names, only those containers are probed.
#
# For every running container attached to a besedy* network it checks that all
# of the container's networks use a br-bsdy* bridge with IPv6 off. It then
# connects from inside the container's network namespace (nsenter, so the
# images need no probe tools) and expects:
#   blocked  - the host on every attached network gateway and on its LAN
#              address, the LAN router, libvirt, and the tailnet
#   open     - an internet address
# A dropped connection times out; a refused or accepted one means the packet
# got past the policy. All probes run in parallel. Exits non-zero on any
# failure.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 2
fi

timeout_s="${EGRESS_PROBE_TIMEOUT:-2}"
internet_target="${EGRESS_INTERNET_TARGET:-1.1.1.1:443}"
failures=0
results_dir="$(mktemp -d)"
trap 'rm -rf "$results_dir"' EXIT

fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

# Prints open, blocked, or what answered for a TCP connect from a network
# namespace whose pid was already checked with nsenter.
probe() {
  local pid="$1" ip="$2" port="$3" rc=0 output
  output="$(nsenter -t "$pid" -n timeout "$timeout_s" bash -c "exec 3<>/dev/tcp/$ip/$port" 2>&1)" || rc=$?
  case "$rc" in
    0) echo open ;;
    124) echo blocked ;;
    *) echo "answered ($(sed -n 's/.*connect: //p' <<<"$output" | head -n 1))" ;;
  esac
}

# Prints "<rule> <packets>" for each commented counter in the policy.
counters() {
  nft list chain inet besedy_egress prerouting 2>/dev/null \
    | sed -n 's/.*counter packets \([0-9]*\) .*comment "\([a-z0-9]*\)".*/\2 \1/p' || true
}

if ! nft list table inet besedy_egress >/dev/null 2>&1; then
  fail "nftables table inet besedy_egress is not loaded (systemctl status besedy-container-egress)"
fi

if [[ "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null || echo 0)" == 1 ]]; then
  fail "br_netfilter is active: traffic between containers on one network would hit the policy"
fi

# Host-side destinations that must be unreachable from every container. Hosts
# without libvirt, Tailscale, or a default route skip those targets.
host_targets=()
lan_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true)"
[[ -n "$lan_ip" ]] && host_targets+=("$lan_ip:22")
router_ip="$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}' || true)"
[[ -n "$router_ip" ]] && host_targets+=("$router_ip:53")
for dev in virbr0 tailscale0; do
  addr="$(ip -4 -o addr show dev "$dev" 2>/dev/null | awk '{split($4, a, "/"); print a[1]; exit}' || true)"
  [[ -n "$addr" ]] && host_targets+=("$addr:22")
done
# Tailscale's resolver sits behind tailscale0, the same path as tailnet peers.
ip link show tailscale0 >/dev/null 2>&1 && host_targets+=("100.100.100.100:53")
# A port the host publishes on all interfaces covers the DNAT path.
published="$(docker ps --format '{{.Ports}}' | tr ',' '\n' | sed -n 's/^ *0\.0\.0\.0:\([0-9]*\)->.*/\1/p' | head -n 1 || true)"
[[ -n "$published" && -n "$lan_ip" ]] && host_targets+=("$lan_ip:$published")

counters_before="$(counters)"

checked=0
job=0
while IFS= read -r container; do
  [[ -n "$container" ]] || continue
  if ! networks="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container" 2>/dev/null)"; then
    fail "$container: no such container"
    continue
  fi
  [[ " $networks" == *" besedy"* ]] || continue
  checked=$((checked + 1))

  targets=("${host_targets[@]}")
  for network in $networks; do
    IFS='|' read -r bridge ipv6 gateway < <(docker network inspect --format \
      '{{index .Options "com.docker.network.bridge.name"}}|{{.EnableIPv6}}|{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$network")
    [[ "$bridge" == br-bsdy* ]] || fail "$container: network $network has bridge '${bridge:-<docker default>}', not br-bsdy* (recreate it)"
    [[ "$ipv6" == false ]] || fail "$container: network $network has IPv6 enabled"
    [[ -n "$gateway" ]] && targets+=("$gateway:22")
  done

  pid="$(docker inspect --format '{{.State.Pid}}' "$container" 2>/dev/null || echo 0)"
  if [[ "$pid" == 0 ]] || ! nsenter -t "$pid" -n true 2>/dev/null; then
    fail "$container: cannot enter its network namespace (stopped or restarting?)"
    continue
  fi

  for target in "${targets[@]}" "internet:$internet_target"; do
    expected=blocked
    if [[ "$target" == internet:* ]]; then
      expected=open
      target="${target#internet:}"
    fi
    job=$((job + 1))
    {
      result="$(probe "$pid" "${target%:*}" "${target##*:}")"
      printf '%s|%s|%s|%s\n' "$container" "$target" "$expected" "$result"
    } >"$results_dir/$job" &
  done
done < <(if (( $# > 0 )); then printf '%s\n' "$@"; else docker ps --format '{{.Names}}' | sort; fi)
wait

while IFS='|' read -r container target expected result; do
  [[ "$result" == "$expected" ]] || fail "$container -> $target is $result, expected $expected"
done < <(cat "$results_dir"/* 2>/dev/null | sort || true)

if (( checked == 0 )); then
  fail "no running containers on besedy* networks"
fi

# This run's probes must have hit the drop rules. Counters that did not move
# would mean the timeouts came from somewhere else and the policy matched
# nothing, the failure mode of the retired iptables control.
counters_after="$(counters)"
for rule in host private; do
  before="$(awk -v r="$rule" '$1 == r {print $2}' <<<"$counters_before")"
  after="$(awk -v r="$rule" '$1 == r {print $2}' <<<"$counters_after")"
  (( ${after:-0} > ${before:-0} )) || fail "drop rule '$rule' matched no packets during this check"
done

if (( failures > 0 )); then
  echo "Egress check: $failures failure(s) across $checked container(s)"
  exit 1
fi
echo "Egress check: OK ($checked containers)"
