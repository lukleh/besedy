#!/bin/bash
# Egress control for Docker containers
# - Blocks container access to LAN (private IP ranges)
# - Leaves inter-container traffic to Docker's own rules
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
#   sudo cp web/setup/egress/besedy-egress*.service /etc/systemd/system/
#   sudo cp web/setup/egress/besedy-egress-refresh.timer /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now besedy-egress.service
#   sudo systemctl enable --now besedy-egress-refresh.timer
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
# Pipelines are guarded with `|| true` so an empty result reaches the explicit
# check in load_subnets instead of killing the script under `set -o pipefail`.
discover_subnets() {
    local ids
    ids=$("$DOCKER_BIN" network ls --filter driver=bridge --quiet) || return 0
    [ -n "$ids" ] || return 0
    # shellcheck disable=SC2086 # word splitting is intended: one arg per network
    { "$DOCKER_BIN" network inspect $ids \
        --format '{{range .IPAM.Config}}{{.Subnet}}
{{end}}' 2>/dev/null \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' \
        | sort -u; } || true
}

load_subnets() {
    local raw
    if [ -n "${DOCKER_SUBNET:-}" ]; then
        raw=$({ tr ',' ' ' <<<"$DOCKER_SUBNET" | tr ' ' '\n' | grep -v '^$' | sort -u; } || true)
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
#
# The egress chain is flushed rather than deleted: `iptables -X` fails while any
# reference to the chain remains, and failing here would leave DOCKER-USER
# already stripped — i.e. the LAN reachable — on every retry.
clean_rules() {
    local nums n
    mapfile -t nums < <(iptables -L "$CHAIN" -n --line-numbers 2>/dev/null \
        | awk -v tag="$COMMENT_TAG" '$0 ~ tag && $1 ~ /^[0-9]+$/ {print $1}' \
        | sort -rn)
    for n in "${nums[@]}"; do
        iptables -D "$CHAIN" "$n"
    done
    iptables -N "$EGRESS_CHAIN" 2>/dev/null || iptables -F "$EGRESS_CHAIN"
}

apply_rules() {
    local subnet range pos

    # Inside the egress chain: reached only by traffic from a container subnet.
    # Order matters — container-to-container destinations are handled before the
    # RFC1918 block, because the Docker subnets live inside 172.16.0.0/12.
    #
    # RETURN, not ACCEPT: an ACCEPT here would terminate FORWARD traversal and
    # skip DOCKER-FORWARD, whose DOCKER chain enforces Docker's own network
    # isolation (`! -i br-X -o br-X -j DROP`) — that would let a container in one
    # compose network reach unpublished ports in another. RETURN hands the packet
    # back and lets Docker decide, which is the pre-existing behaviour.
    for subnet in "${SUBNETS[@]}"; do
        iptables -A "$EGRESS_CHAIN" -d "$subnet" -j RETURN \
            -m comment --comment "$COMMENT_TAG: inter-container, defer to Docker ($subnet)"
    done
    for range in "${PRIVATE_RANGES[@]}"; do
        iptables -A "$EGRESS_CHAIN" -d "$range" -j DROP \
            -m comment --comment "$COMMENT_TAG: block LAN ($range)"
    done
    # Anything else falls off the end of the chain and returns to DOCKER-USER,
    # which is what keeps outbound internet (OAuth) working.

    # Insert at the top of DOCKER-USER rather than appending: Docker 28 and
    # earlier seed the chain with a terminal `-j RETURN`, and anything appended
    # after it would never be evaluated.
    iptables -I "$CHAIN" 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT \
        -m comment --comment "$COMMENT_TAG: allow established"
    pos=2
    for subnet in "${SUBNETS[@]}"; do
        iptables -I "$CHAIN" "$pos" -s "$subnet" -j "$EGRESS_CHAIN" \
            -m comment --comment "$COMMENT_TAG: filter egress ($subnet)"
        pos=$((pos + 1))
    done
}

print_plan() {
    local subnet range
    echo "Would install, in $EGRESS_CHAIN:"
    for subnet in "${SUBNETS[@]}"; do echo "  RETURN -d $subnet   (inter-container, defer to Docker)"; done
    for range in "${PRIVATE_RANGES[@]}"; do echo "  DROP   -d $range   (block LAN)"; done
    echo "Would insert, at the top of $CHAIN:"
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

# A rule that sits below an unconditional RETURN/ACCEPT/DROP in DOCKER-USER is
# never evaluated, so presence alone would report a ruleset that enforces
# nothing as healthy.
check_position() {
    local terminal_line jump_line
    terminal_line=$(iptables -L "$CHAIN" -n --line-numbers 2>/dev/null \
        | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^(RETURN|ACCEPT|DROP)$/ && $5 == "0.0.0.0/0" && $6 == "0.0.0.0/0" && $0 !~ /state|ctstate|besedy-egress/ {print $1; exit}')
    [ -n "$terminal_line" ] || return 0
    jump_line=$(iptables -L "$CHAIN" -n --line-numbers 2>/dev/null \
        | awk -v chain="$EGRESS_CHAIN" '$1 ~ /^[0-9]+$/ && $2 == chain {print $1; exit}')
    [ -n "$jump_line" ] || return 0
    if [ "$terminal_line" -lt "$jump_line" ]; then
        echo "UNREACHABLE: $CHAIN rule $terminal_line terminates before the egress jump at $jump_line"
        return 1
    fi
}

# Verify the live ruleset still matches the live networks. Presence of rules is
# not enough: rules naming a subnet nothing uses any more enforce nothing.
verify_rules() {
    local problems=0 subnet range live tagged stale

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
        rule_exists "$EGRESS_CHAIN" -d "$subnet" RETURN "$live" || {
            echo "MISSING: no inter-container rule for active subnet $subnet"
            problems=$((problems + 1))
        }
    done
    for range in "${PRIVATE_RANGES[@]}"; do
        rule_exists "$EGRESS_CHAIN" -d "$range" DROP "$live" || {
            echo "MISSING: no DROP rule for $range"
            problems=$((problems + 1))
        }
    done

    check_position || problems=$((problems + 1))

    # Rules naming subnets that no longer exist are stale, not harmful, but they
    # are the signature of the drift this script exists to prevent. Only our own
    # rules are scanned — other tools put their own CIDRs in DOCKER-USER.
    tagged=$(grep -F -- "$COMMENT_TAG" <<<"$live" || true)
    while read -r stale; do
        [ -n "$stale" ] || continue
        printf '%s\n' "${SUBNETS[@]}" | grep -qxF "$stale" || {
            echo "STALE: rule references $stale, which no Docker network uses"
            problems=$((problems + 1))
        }
    done < <({ grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+' <<<"$tagged" \
        | sort -u | grep -vxF -f <(printf '%s\n' "${PRIVATE_RANGES[@]}"); } || true)

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
