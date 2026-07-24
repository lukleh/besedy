#!/bin/bash
# Egress control for Docker containers
# - Blocks container access to LAN (private IP ranges)
# - Allows inter-container traffic (web → db)
# - Allows internet access (for OAuth)
#
# Installation:
#   sudo cp web/setup/egress/iptables-egress.sh /usr/local/bin/
#   sudo chmod +x /usr/local/bin/iptables-egress.sh
#   sudo cp web/setup/egress/besedy-egress.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable besedy-egress.service
#   sudo systemctl start besedy-egress.service
#
# Configuration:
#   DOCKER_SUBNET - Docker network subnet (default: 172.18.0.0/16)
#
# See docs/web/security.md for details.

set -euo pipefail

# Configuration - adjust DOCKER_SUBNET if your Docker uses different range
# Default matches besedy-prod_default network (check with: docker network inspect besedy-prod_default)
DOCKER_SUBNET="${DOCKER_SUBNET:-172.22.0.0/16}"

# Private IP ranges (RFC 1918) to block
PRIVATE_RANGES=(
    "10.0.0.0/8"
    "172.16.0.0/12"
    "192.168.0.0/16"
)

# Use DOCKER-USER chain (Docker 17.06+)
CHAIN="DOCKER-USER"

echo "=== Besedy Egress Control ==="
echo "Docker subnet: $DOCKER_SUBNET"
echo "Blocking LAN access for containers..."

# Remove existing besedy rules (idempotent)
# Delete each type of rule repeatedly until none remain
echo "Cleaning up existing rules..."
while iptables -D "$CHAIN" -s "$DOCKER_SUBNET" -d "$DOCKER_SUBNET" \
    -m comment --comment "besedy-egress: allow inter-container" -j ACCEPT 2>/dev/null; do :; done
while iptables -D "$CHAIN" -m state --state ESTABLISHED,RELATED \
    -m comment --comment "besedy-egress: allow established" -j ACCEPT 2>/dev/null; do :; done
for range in "${PRIVATE_RANGES[@]}"; do
    while iptables -D "$CHAIN" -s "$DOCKER_SUBNET" -d "$range" \
        -m comment --comment "besedy-egress: block LAN ($range)" -j DROP 2>/dev/null; do :; done
done

# Rule order matters! Insert in reverse order (last rule inserted = first checked)

# 3. Block private ranges (LAN) - inserted last, checked after inter-container
for range in "${PRIVATE_RANGES[@]}"; do
    iptables -A "$CHAIN" -s "$DOCKER_SUBNET" -d "$range" -j DROP \
        -m comment --comment "besedy-egress: block LAN ($range)"
    echo "  Blocked: $range"
done

# 2. Allow established/related connections (for return traffic)
iptables -I "$CHAIN" -m state --state ESTABLISHED,RELATED -j ACCEPT \
    -m comment --comment "besedy-egress: allow established"

# 1. Allow inter-container traffic (checked first)
iptables -I "$CHAIN" -s "$DOCKER_SUBNET" -d "$DOCKER_SUBNET" -j ACCEPT \
    -m comment --comment "besedy-egress: allow inter-container"

echo ""
echo "Rules applied. Current DOCKER-USER chain:"
iptables -L "$CHAIN" -n -v --line-numbers | head -20
