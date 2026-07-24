#!/bin/bash
# Monthly security update check for Besedy containers
#
# Installation (user crontab):
#   crontab -e
#   # Add: 0 7 1 * * REPORT_EMAIL="you@example.com" /path/to/security-update-check.sh 2>&1 | logger -t besedy-security
#
# Configuration (environment variables):
#   REPORT_EMAIL - Email address for reports (requires sendmail/msmtp)
#   BESEDY_COMPOSE_DIR - Path to web directory (default: auto-detected from the script's location)
#   BASE_IMAGE_MAX_AGE_DAYS - Alert if base image older than this (default: 30)

set -euo pipefail

COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="$(cd "$COMPOSE_DIR/.." && pwd)"
ENV_FILE="$("$PROJECT_DIR/scripts/resolve_web_env_file.sh" production)"
REPORT_EMAIL="${REPORT_EMAIL:-}"
BASE_IMAGE_MAX_AGE_DAYS="${BASE_IMAGE_MAX_AGE_DAYS:-30}"
CONTAINER_NAME="${BESEDY_CONTAINER_NAME:-besedy-production-web}"

base_image_ref() {
    awk '/^FROM / && $3 == "AS" && $4 == "base" { print $2; exit }' "$COMPOSE_DIR/Dockerfile"
}

BASE_IMAGE_REF="$(base_image_ref)"
if [ -z "$BASE_IMAGE_REF" ]; then
    BASE_IMAGE_REF="node:24-alpine"
fi

# Compose command for production (base + security overlay)
compose_cmd() {
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" -f "$COMPOSE_DIR/docker-compose.secure.yml" --env-file "$ENV_FILE" "$@"
}

echo "=== Besedy Security Update Check ==="
echo "Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Check npm audit against the repo lockfile in a short-lived Node container
# (the hardened production image intentionally omits npm).
# Note: npm audit exits with code 1 when vulnerabilities exist - this is expected.
echo "Checking npm vulnerabilities..."
NPM_AUDIT_FAILED="no"
NPM_AUDIT=$(
    docker run --rm \
        -v "$COMPOSE_DIR/package.json:/app/package.json:ro" \
        -v "$COMPOSE_DIR/package-lock.json:/app/package-lock.json:ro" \
        -w /app \
        "$BASE_IMAGE_REF" \
        npm audit --omit=dev --omit=optional --package-lock-only --json 2>/dev/null
) || true

# Parse audit results - check if we got valid JSON with metadata
if echo "$NPM_AUDIT" | jq -e '.metadata.vulnerabilities' >/dev/null 2>&1; then
    VULN_HIGH=$(echo "$NPM_AUDIT" | jq -r '.metadata.vulnerabilities.high // 0')
    VULN_CRITICAL=$(echo "$NPM_AUDIT" | jq -r '.metadata.vulnerabilities.critical // 0')
    VULN_MODERATE=$(echo "$NPM_AUDIT" | jq -r '.metadata.vulnerabilities.moderate // 0')
    VULN_COUNT="$((VULN_HIGH + VULN_CRITICAL))"
    VULN_SUMMARY="Critical: $VULN_CRITICAL, High: $VULN_HIGH, Moderate: $VULN_MODERATE"
    VULN_PACKAGES=$(echo "$NPM_AUDIT" | jq -r '
        .vulnerabilities
        | to_entries
        | map(select(.value.severity == "high" or .value.severity == "critical"))
        | if length == 0 then
            "  (none)"
          else
            .[] | "  - \(.key) (severity=\(.value.severity), direct=\(.value.isDirect), fix=\(.value.fixAvailable))"
          end
    ')
else
    VULN_SUMMARY="npm audit FAILED (container: $CONTAINER_NAME)"
    VULN_COUNT=0
    VULN_PACKAGES="  (audit unavailable)"
    NPM_AUDIT_FAILED="yes"
fi

# Run Trivy CVE scan on the production image
echo "Running Trivy CVE scan..."
TRIVY_SCAN_FAILED="no"
TRIVY_CRITICAL=0
TRIVY_HIGH=0
TRIVY_CVE_COUNT=0
TRIVY_SUMMARY=""
TRIVY_DETAILS=""

# Get the production image name
PROD_IMAGE=$(docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}' 2>/dev/null || echo "")

if [ -n "$PROD_IMAGE" ]; then
    # Run Trivy as a container (no installation required)
    # Only scan for HIGH and CRITICAL vulnerabilities, output as JSON
    TRIVY_OUTPUT=$(docker run --rm \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v trivy-cache:/root/.cache/ \
        aquasec/trivy:latest image \
        --severity HIGH,CRITICAL \
        --format json \
        --quiet \
        "$PROD_IMAGE" 2>/dev/null) && TRIVY_AVAILABLE="yes" || TRIVY_AVAILABLE="no"

    if [ "$TRIVY_AVAILABLE" = "yes" ] && [ -n "$TRIVY_OUTPUT" ]; then
        # Parse Trivy JSON output
        TRIVY_CRITICAL=$(echo "$TRIVY_OUTPUT" | jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' 2>/dev/null || echo "0")
        TRIVY_HIGH=$(echo "$TRIVY_OUTPUT" | jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' 2>/dev/null || echo "0")
        TRIVY_CVE_COUNT=$((TRIVY_CRITICAL + TRIVY_HIGH))
        TRIVY_SUMMARY="Critical: $TRIVY_CRITICAL, High: $TRIVY_HIGH"

        # Get details of vulnerabilities (limit to first 10)
        TRIVY_DETAILS=$(echo "$TRIVY_OUTPUT" | jq -r '
            [.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL" or .Severity == "HIGH")]
            | .[0:10]
            | if length == 0 then
                "  (none)"
              else
                .[] | "  - \(.VulnerabilityID) (\(.Severity)): \(.PkgName) \(.InstalledVersion) -> \(.FixedVersion // "no fix")"
              end
        ' 2>/dev/null || echo "  (parse error)")

        # Check if there are more than 10
        TOTAL_VULNS=$(echo "$TRIVY_OUTPUT" | jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL" or .Severity == "HIGH")] | length' 2>/dev/null || echo "0")
        if [ "$TOTAL_VULNS" -gt 10 ]; then
            TRIVY_DETAILS="${TRIVY_DETAILS}
  ... and $((TOTAL_VULNS - 10)) more"
        fi
    else
        TRIVY_SUMMARY="Trivy scan FAILED"
        TRIVY_DETAILS="  (scan unavailable)"
        TRIVY_SCAN_FAILED="yes"
    fi
else
    TRIVY_SUMMARY="Could not determine production image (container: $CONTAINER_NAME)"
    TRIVY_DETAILS="  (container not running?)"
    TRIVY_SCAN_FAILED="yes"
fi

# Check current base image age
echo "Checking base image..."
IMAGE_ID=$(docker images "$BASE_IMAGE_REF" --format "{{.ID}}" 2>/dev/null | head -1)
IMAGE_AGE_DAYS=0
if [ -n "$IMAGE_ID" ]; then
    IMAGE_CREATED=$(docker inspect "$IMAGE_ID" --format '{{.Created}}' 2>/dev/null | cut -d'T' -f1)
    IMAGE_AGE="Created: $IMAGE_CREATED"
    # Calculate age in days
    IMAGE_CREATED_EPOCH=$(date -d "$IMAGE_CREATED" +%s 2>/dev/null || echo "0")
    CURRENT_EPOCH=$(date +%s)
    if [ "$IMAGE_CREATED_EPOCH" != "0" ]; then
        IMAGE_AGE_DAYS=$(( (CURRENT_EPOCH - IMAGE_CREATED_EPOCH) / 86400 ))
        IMAGE_AGE="Created: $IMAGE_CREATED ($IMAGE_AGE_DAYS days ago)"
    fi
else
    IMAGE_AGE="$BASE_IMAGE_REF not found locally"
fi

# Check for new base image and age-based alerting
echo "Checking for base image updates..."
IMAGE_NEEDS_UPDATE="no"
NEW_IMAGE_AVAILABLE="no"

# Try to pull latest image
docker pull "$BASE_IMAGE_REF" > /dev/null 2>&1 && NEW_IMAGE_PULLED="yes" || NEW_IMAGE_PULLED="no"
if [ "$NEW_IMAGE_PULLED" = "yes" ]; then
    NEW_IMAGE_ID=$(docker images "$BASE_IMAGE_REF" --format "{{.ID}}" 2>/dev/null | head -1)
    if [ "$NEW_IMAGE_ID" != "$IMAGE_ID" ]; then
        NEW_IMAGE_AVAILABLE="yes"
    fi
fi

# Alert based on age threshold (regardless of pull outcome)
if [ "$IMAGE_AGE_DAYS" -gt "$BASE_IMAGE_MAX_AGE_DAYS" ]; then
    IMAGE_UPDATE="Base image is $IMAGE_AGE_DAYS days old (>${BASE_IMAGE_MAX_AGE_DAYS} days) - rebuild recommended"
    IMAGE_NEEDS_UPDATE="yes"
elif [ "$NEW_IMAGE_AVAILABLE" = "yes" ]; then
    IMAGE_UPDATE="New base image available (current is $IMAGE_AGE_DAYS days old - within threshold)"
    IMAGE_NEEDS_UPDATE="no"
elif [ "$NEW_IMAGE_PULLED" = "no" ]; then
    if [ "$IMAGE_AGE_DAYS" -gt "$BASE_IMAGE_MAX_AGE_DAYS" ]; then
        IMAGE_UPDATE="Base image is $IMAGE_AGE_DAYS days old (>${BASE_IMAGE_MAX_AGE_DAYS} days) - rebuild recommended (pull failed)"
        IMAGE_NEEDS_UPDATE="yes"
    else
        IMAGE_UPDATE="Could not check for updates (pull failed, image is $IMAGE_AGE_DAYS days old)"
        IMAGE_NEEDS_UPDATE="no"
    fi
else
    IMAGE_UPDATE="Base image is current"
    IMAGE_NEEDS_UPDATE="no"
fi

PROD_IMAGE_AGE_DAYS=0
PROD_IMAGE_AGE="unknown"
PROD_IMAGE_NEEDS_REBUILD="no"
PROD_IMAGE_REBUILD_STATUS="Production image build date unknown"
PROD_IMAGE_CREATED_FOUND="no"

if [ -n "$PROD_IMAGE" ]; then
    PROD_IMAGE_CREATED_ISO=$(docker image inspect "$PROD_IMAGE" --format '{{.Created}}' 2>/dev/null || echo "")
    if [ -n "$PROD_IMAGE_CREATED_ISO" ]; then
        PROD_IMAGE_CREATED_FOUND="yes"
        PROD_IMAGE_CREATED=$(echo "$PROD_IMAGE_CREATED_ISO" | cut -d'T' -f1)
        PROD_IMAGE_CREATED_EPOCH=$(date -d "$PROD_IMAGE_CREATED" +%s 2>/dev/null || echo "0")
        CURRENT_EPOCH=$(date +%s)
        PROD_IMAGE_AGE="Created: $PROD_IMAGE_CREATED"
        if [ "$PROD_IMAGE_CREATED_EPOCH" != "0" ]; then
            PROD_IMAGE_AGE_DAYS=$(( (CURRENT_EPOCH - PROD_IMAGE_CREATED_EPOCH) / 86400 ))
            PROD_IMAGE_AGE="Created: $PROD_IMAGE_CREATED ($PROD_IMAGE_AGE_DAYS days ago)"
        fi
    fi
fi

if [ "$PROD_IMAGE_AGE_DAYS" -gt "$BASE_IMAGE_MAX_AGE_DAYS" ]; then
    PROD_IMAGE_NEEDS_REBUILD="yes"
    PROD_IMAGE_REBUILD_STATUS="Production image is $PROD_IMAGE_AGE_DAYS days old (>${BASE_IMAGE_MAX_AGE_DAYS} days) - rebuild recommended"
elif [ "$PROD_IMAGE_CREATED_FOUND" = "yes" ]; then
    PROD_IMAGE_REBUILD_STATUS="Production image age is within threshold"
fi

# Check container uptime
CONTAINER_STARTED=$(docker inspect "$CONTAINER_NAME" --format '{{.State.StartedAt}}' 2>/dev/null || echo "unknown")
if [ "$CONTAINER_STARTED" != "unknown" ]; then
    CONTAINER_UPTIME=$(echo "$CONTAINER_STARTED" | cut -d'T' -f1)
else
    CONTAINER_UPTIME="unknown"
fi

# Build report
REPORT="BESEDY SECURITY UPDATE CHECK
==============================
Date: $(date '+%Y-%m-%d %H:%M:%S')

NPM VULNERABILITIES
-------------------
$VULN_SUMMARY

VULNERABLE PACKAGES
-------------------
$VULN_PACKAGES

CONTAINER CVEs (Trivy)
----------------------
$TRIVY_SUMMARY

CVE DETAILS
-----------
$TRIVY_DETAILS

BASE IMAGE
----------
Current: $IMAGE_AGE
Status: $IMAGE_UPDATE

CONTAINER
---------
Production image: $PROD_IMAGE_AGE
Image status: $PROD_IMAGE_REBUILD_STATUS
Running since: $CONTAINER_UPTIME
"

# Determine if action needed
NEEDS_ACTION="no"

# Check for scan failures first
if [ "$NPM_AUDIT_FAILED" = "yes" ] || [ "$TRIVY_SCAN_FAILED" = "yes" ]; then
    NEEDS_ACTION="yes"
    REPORT="${REPORT}
WARNING: CHECKS FAILED
----------------------"
    if [ "$NPM_AUDIT_FAILED" = "yes" ]; then
        REPORT="${REPORT}
- npm audit failed for $COMPOSE_DIR/package-lock.json"
    fi
    if [ "$TRIVY_SCAN_FAILED" = "yes" ]; then
        REPORT="${REPORT}
- Trivy CVE scan failed"
    fi
    REPORT="${REPORT}
Investigate and re-run manually.
"
fi

if [ "$VULN_COUNT" -gt 0 ]; then
    NEEDS_ACTION="yes"
    REPORT="${REPORT}
ACTION REQUIRED (npm)
---------------------
$VULN_COUNT high/critical npm vulnerabilities found.
Run: cd ${COMPOSE_DIR%/web} && just prod-rebuild
"
fi

if [ "$TRIVY_CVE_COUNT" -gt 0 ]; then
    NEEDS_ACTION="yes"
    REPORT="${REPORT}
ACTION REQUIRED (CVEs)
----------------------
$TRIVY_CVE_COUNT high/critical container CVEs found.
Rebuild to get patched base image:
  cd ${COMPOSE_DIR%/web} && just prod-rebuild
"
fi

if [ "$IMAGE_NEEDS_UPDATE" = "yes" ]; then
    NEEDS_ACTION="yes"
    REPORT="${REPORT}
RECOMMENDED ACTION
------------------
Base image is $IMAGE_AGE_DAYS days old (threshold: $BASE_IMAGE_MAX_AGE_DAYS days).
Rebuild to get latest security patches:
  cd ${COMPOSE_DIR%/web} && just prod-rebuild
"
fi

if [ "$PROD_IMAGE_NEEDS_REBUILD" = "yes" ]; then
    NEEDS_ACTION="yes"
    REPORT="${REPORT}
RECOMMENDED ACTION
------------------
Production image is $PROD_IMAGE_AGE_DAYS days old (threshold: $BASE_IMAGE_MAX_AGE_DAYS days).
Rebuild to refresh application dependencies and base layers:
  cd ${COMPOSE_DIR%/web} && just prod-rebuild
"
fi

if [ "$NEEDS_ACTION" = "no" ]; then
    REPORT="${REPORT}
STATUS: All clear - no action needed
"
fi

REPORT="${REPORT}
---
To manually run npm audit:
  docker run --rm -v $COMPOSE_DIR/package.json:/app/package.json:ro -v $COMPOSE_DIR/package-lock.json:/app/package-lock.json:ro -w /app $BASE_IMAGE_REF npm audit --omit=dev --omit=optional --package-lock-only

To manually run Trivy CVE scan:
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy image $CONTAINER_NAME

To rebuild with latest base image:
  cd ${COMPOSE_DIR%/web} && just prod-rebuild
"

# Send email if configured
if [ -n "$REPORT_EMAIL" ]; then
    if [ "$NEEDS_ACTION" = "yes" ]; then
        SUBJECT="[Besedy] Security Update NEEDED - $(date +%Y-%m-%d)"
    else
        SUBJECT="[Besedy] Security Check OK - $(date +%Y-%m-%d)"
    fi

    {
        echo "Subject: $SUBJECT"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "$REPORT"
    } | sendmail "$REPORT_EMAIL"

    logger -t besedy-security "Security check sent to $REPORT_EMAIL (action_needed=$NEEDS_ACTION)"
else
    # Output to stdout
    echo "$REPORT"
    logger -t besedy-security "Security check completed (action_needed=$NEEDS_ACTION, no email configured)"
fi
