#!/bin/bash
# Egress control for Docker containers
# - Blocks container access to LAN (private IP ranges)
# - Allows inter-container traffic (web → db)
# - Allows internet access (for OAuth)
#
# Container subnets are discovered from Docker at runtime. Do not hardcode them:
# compose recreates its networks whenever a stack is torn down, and Docker then
# re-allocates subnets from its pool. A stale hardcoded subnet matches nothing
# and the LAN block silently stops applying.
#
# Installation:
#   sudo cp web/setup/egress/iptables-egress.sh /usr/local/bin/
#   sudo chmod +x /usr/local/bin/iptables-egress.sh
#   sudo cp web/setup/egress/besedy-egress.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now besedy-egress.service
#
# Usage:
#   iptables-egress.sh              apply the rules (idempotent)
#   iptables-egress.sh --verify     check the live rules match the live networks
#   iptables-egress.sh --dry-run    print what would be applied, change nothing
#
# Configuration:
#   DOCKER_SUBNET   - space/comma separated subnets, overriding discovery
#   DOCKER_WAIT_SEC - how long to wait for the Docker API at boot (default 60)
#
# See docs/web/security.md for details.

set -euo pipefail

CHAIN="DOCKER-USER"
EGRESS_CHAIN="BESEDY-EGRESS"
COMMENT_TAG="besedy-egress"
DOCKER_BIN="${DOCKER_BIN:-docker}"
DOCKER_WAIT_SEC="${DOCKER_WAIT_SEC:-60}"

# Private IP ranges (RFC 1918) to block
PRIVATE_RANGES=(
    "10.0.0.0/8"
    "172.16.0.0/12"
    "192.168.0.0/16"
)

MODE="apply"
case "${1:-}" in
    --verify)  MODE="verify" ;;
    --dry-run) MODE="dry-run" ;;
    "")        ;;
    *)         echo "Usage: $0 [--verify|--dry-run]" >&2; exit 2 ;;
esac

die() { echo "ERROR: $*" >&2; exit 1; }

require_root() {
    [ "$(id -u)" -eq 0 ] || die "must run as root (iptables)"
}

wait_for_docker() {
    local waited=0
    until "$DOCKER_BIN" info >/dev/null 2>&1; do
        [ "$waited" -ge "$DOCKER_WAIT_SEC" ] && \
            die "Docker API not responding after ${DOCKER_WAIT_SEC}s"
        sleep 2
        waited=$((waited + 2))
    done
}

# Every IPv4 subnet Docker currently manages. These are the source addresses the
# containers actually use, so they are what the rules have to be written against.
discover_subnets() {
    local ids
    ids=$("$DOCKER_BIN" network ls --filter driver=bridge --quiet)
    [ -n "$ids" ] || return 0
    # shellcheck disable=SC2086 # word splitting is intended: one arg per network
    "$DOCKER_BIN" network inspect $ids \
        --format '{{range .IPAM.Config}}{{.Subnet}}
{{end}}' 2>/dev/null \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' \
        | sort -u
}

load_subnets() {
    local raw
    if [ -n "${DOCKER_SUBNET:-}" ]; then
        raw=$(tr ',' ' ' <<<"$DOCKER_SUBNET" | tr ' ' '\n' | grep -v '^$' | sort -u)
        echo "Using DOCKER_SUBNET override" >&2
    else
        wait_for_docker
        raw=$(discover_subnets)
    fi
    mapfile -t SUBNETS <<<"$raw"
    # mapfile on empty input still yields one empty element
    [ "${#SUBNETS[@]}" -eq 1 ] && [ -z "${SUBNETS[0]}" ] && SUBNETS=()
    # Fail loudly: installing no rules would silently leave the LAN reachable.
    [ "${#SUBNETS[@]}" -gt 0 ] || die "no Docker IPv4 subnets found — refusing to install an empty ruleset"
}

# Drop every rule we previously installed, matched by comment tag rather than by
# exact rule text, so rules written for subnets that no longer exist are removed
# too. Line numbers are deleted highest-first so earlier ones stay valid.
clean_rules() {
    local nums n
    mapfile -t nums < <(iptables -L "$CHAIN" -n --line-numbers 2>/dev/null \
        | awk -v tag="$COMMENT_TAG" '$0 ~ tag && $1 ~ /^[0-9]+$/ {print $1}' \
        | sort -rn)
    for n in "${nums[@]}"; do
        iptables -D "$CHAIN" "$n"
    done
    if iptables -L "$EGRESS_CHAIN" -n >/dev/null 2>&1; then
        iptables -F "$EGRESS_CHAIN"
        iptables -X "$EGRESS_CHAIN"
    fi
}

apply_rules() {
    local subnet range

    iptables -N "$EGRESS_CHAIN"

    # Inside the egress chain: reached only by traffic from a container subnet.
    # Order matters — inter-container traffic is accepted before the RFC1918
    # block, because the Docker subnets themselves live inside 172.16.0.0/12.
    for subnet in "${SUBNETS[@]}"; do
        iptables -A "$EGRESS_CHAIN" -d "$subnet" -j ACCEPT \
            -m comment --comment "$COMMENT_TAG: allow inter-container ($subnet)"
    done
    for range in "${PRIVATE_RANGES[@]}"; do
        iptables -A "$EGRESS_CHAIN" -d "$range" -j DROP \
            -m comment --comment "$COMMENT_TAG: block LAN ($range)"
    done
    # Anything else falls off the end of the chain and returns to DOCKER-USER,
    # which is what keeps outbound internet (OAuth) working.

    # Return traffic first, then hand container-sourced traffic to our chain.
    for subnet in "${SUBNETS[@]}"; do
        iptables -A "$CHAIN" -s "$subnet" -j "$EGRESS_CHAIN" \
            -m comment --comment "$COMMENT_TAG: filter egress ($subnet)"
    done
    iptables -I "$CHAIN" 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT \
        -m comment --comment "$COMMENT_TAG: allow established"
}

print_plan() {
    local subnet range
    echo "Would install, in $EGRESS_CHAIN:"
    for subnet in "${SUBNETS[@]}"; do echo "  ACCEPT -d $subnet   (inter-container)"; done
    for range in "${PRIVATE_RANGES[@]}"; do echo "  DROP   -d $range   (block LAN)"; done
    echo "Would install, in $CHAIN:"
    echo "  ACCEPT conntrack ESTABLISHED,RELATED"
    for subnet in "${SUBNETS[@]}"; do echo "  -s $subnet -j $EGRESS_CHAIN"; done
}

# iptables -S prints matches between the address and the target
# ("-s SUBNET -m comment ... -j TARGET"), so these checks match on a pattern
# rather than a literal rule string.
rule_exists() {
    local chain="$1" direction="$2" cidr="$3" target="$4" live="$5" pattern
    pattern="^-A $chain $direction ${cidr//./\\.} .*-j $target\$"
    grep -Eq -- "$pattern" <<<"$live"
}

# Verify the live ruleset still matches the live networks. Presence of rules is
# not enough: rules naming a subnet nothing uses any more enforce nothing.
verify_rules() {
    local problems=0 subnet range live

    if ! iptables -L "$EGRESS_CHAIN" -n >/dev/null 2>&1; then
        echo "MISSING: chain $EGRESS_CHAIN does not exist"
        return 1
    fi
    live=$(iptables -S "$EGRESS_CHAIN"; iptables -S "$CHAIN")

    for subnet in "${SUBNETS[@]}"; do
        rule_exists "$CHAIN" -s "$subnet" "$EGRESS_CHAIN" "$live" || {
            echo "MISSING: no egress filter for active subnet $subnet"
            problems=$((problems + 1))
        }
        rule_exists "$EGRESS_CHAIN" -d "$subnet" ACCEPT "$live" || {
            echo "MISSING: no inter-container accept for active subnet $subnet"
            problems=$((problems + 1))
        }
    done
    for range in "${PRIVATE_RANGES[@]}"; do
        rule_exists "$EGRESS_CHAIN" -d "$range" DROP "$live" || {
            echo "MISSING: no DROP rule for $range"
            problems=$((problems + 1))
        }
    done

    # Rules naming subnets that no longer exist are stale, not harmful, but they
    # are the signature of the drift this script exists to prevent.
    while read -r stale; do
        [ -n "$stale" ] || continue
        printf '%s\n' "${SUBNETS[@]}" | grep -qx "$stale" || {
            echo "STALE: rule references $stale, which no Docker network uses"
            problems=$((problems + 1))
        }
    done < <(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+' <<<"$live" \
        | sort -u | grep -vxF -f <(printf '%s\n' "${PRIVATE_RANGES[@]}") || true)

    if [ "$problems" -gt 0 ]; then
        echo "FAIL: $problems problem(s) — egress controls are not fully enforcing"
        return 1
    fi
    echo "OK: egress rules cover all ${#SUBNETS[@]} active Docker subnets"
}

main() {
    require_root
    load_subnets

    if [ "$MODE" = "verify" ]; then
        verify_rules
        return
    fi

    echo "=== Besedy Egress Control ==="
    echo "Docker subnets (${#SUBNETS[@]}): ${SUBNETS[*]}"

    if [ "$MODE" = "dry-run" ]; then
        print_plan
        return
    fi

    echo "Cleaning up existing rules..."
    clean_rules
    echo "Blocking LAN access for containers..."
    apply_rules

    echo ""
    echo "Rules applied. $CHAIN:"
    iptables -L "$CHAIN" -n -v --line-numbers
    echo ""
    echo "$EGRESS_CHAIN:"
    iptables -L "$EGRESS_CHAIN" -n -v --line-numbers
}

main
