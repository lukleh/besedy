#!/usr/bin/env bash
# Nightly integrity check of live transcript-correction workspaces (ADR 0012).
#
# Correction work cannot be redone, so this checks every night that what it
# depends on is intact: the frozen source and its fingerprint, the stored
# spans against a fresh segmentation of that source, the staged audio's size
# (its SHA-256 once per AUDIO_HASH_EVERY_DAYS), the workspace manifest the
# Python guards read, and every text revision against its hash. It also
# reports orphan manifests that keep staged audio for no live workspace. The
# database rows come from PostgreSQL; the
# checks run in besedy.lib.correction_integrity on the host, which sees the
# corrections tree and the staged audio at the paths the workspaces recorded.
#
# Cron (host):
#   30 4 * * * ALERT_EMAIL=... BESEDY_COMPOSE_DIR=.../web .../web/scripts/correction-integrity-check.sh
#
# Environment:
#   BESEDY_COMPOSE_DIR   web/ of the deployed checkout (default: this script's web/)
#   WEB_MODE             compose mode for run_web_compose.sh (default: production)
#   DB_USER / DB_NAME    database role and name (default: besedy_app / besedy)
#   UV_BIN               uv executable (default: uv on PATH, else ~/.local/bin/uv)
#   AUDIO_HASH_EVERY_DAYS  hash each staged WAV on one night in N (default: 7)
#   INTEGRITY_ARGS       extra arguments, e.g. --map-path FROM=TO
#   ALERT_EMAIL          where to mail a failure

set -euo pipefail

COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="$(cd "$COMPOSE_DIR/.." && pwd)"
WEB_MODE="${WEB_MODE:-production}"
DB_USER="${DB_USER:-besedy_app}"
DB_NAME="${DB_NAME:-besedy}"
UV_BIN="${UV_BIN:-$(command -v uv || echo "$HOME/.local/bin/uv")}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
AUDIO_HASH_EVERY_DAYS="${AUDIO_HASH_EVERY_DAYS:-7}"
TAG="${REPORT_LOG_TAG:-besedy-correction-integrity}"

alert() {
  local subject="$1"
  local body="$2"
  logger -t "$TAG" "$subject"
  if [ -n "$ALERT_EMAIL" ] && command -v sendmail >/dev/null 2>&1; then
    {
      echo "Subject: [Besedy] $subject - $(date +%Y-%m-%d)"
      echo "Content-Type: text/plain; charset=utf-8"
      echo ""
      echo "$body"
    } | sendmail "$ALERT_EMAIL" || logger -t "$TAG" "Could not email to $ALERT_EMAIL"
  fi
}

on_error() {
  local status="$1"
  local line="$2"
  trap - ERR
  alert "Correction integrity check could not run" \
    "The correction integrity check failed at line $line with status $status before reaching a verdict."
  exit "$status"
}
trap 'on_error "$?" "$LINENO"' ERR

DB_CONTAINER_ID="$("$PROJECT_DIR/scripts/run_web_compose.sh" "$WEB_MODE" ps -q db)"
if [ -z "$DB_CONTAINER_ID" ]; then
  echo "The $WEB_MODE database container is not running." >&2
  false
fi

# One JSON array of the live workspaces under the data contract, with their
# spans and the number of revisions whose text no longer matches its hash.
WORKSPACES_JSON="$(docker exec -i "$DB_CONTAINER_ID" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -tA -c "
  SELECT COALESCE(json_agg(row_to_json(w)), '[]'::json) FROM (
    SELECT
      ws.id,
      ws.workflow_group_id,
      ws.audio_hash,
      ws.source_fingerprint,
      ws.segmentation_version,
      ws.segmentation_params,
      ws.source_chunk_count,
      ws.staged_audio_path,
      ws.staged_audio_size,
      ws.staged_audio_sha256,
      (
        SELECT COALESCE(json_agg(json_build_array(
          s.chunk_ordinal, s.first_region_index, s.last_region_index, s.start_sample, s.end_sample
        ) ORDER BY s.ordinal), '[]'::json)
        FROM transcript_span s WHERE s.workspace_id = ws.id
      ) AS spans,
      (
        SELECT COUNT(*) FROM transcript_span_revision r
        WHERE r.workspace_id = ws.id
          AND encode(sha256(convert_to(r.text, 'UTF8')), 'hex') <> r.text_hash
      ) AS bad_revision_hashes
    FROM transcript_workspace ws
    WHERE ws.status = 'ACTIVE' AND ws.segmentation_version IS NOT NULL
    ORDER BY ws.created_at
  ) w")"

# Inside an if, a non-zero exit is the verdict rather than a script error: the
# ERR trap fires on failing commands even with errexit off, but not in a test.
# shellcheck disable=SC2086 # INTEGRITY_ARGS is a list of arguments
if REPORT="$(printf '%s' "$WORKSPACES_JSON" | (cd "$PROJECT_DIR" && "$UV_BIN" run --quiet --locked python -m besedy.lib.correction_integrity --audio-hash-every-days "$AUDIO_HASH_EVERY_DAYS" ${INTEGRITY_ARGS:-}) 2>&1)"; then
  STATUS=0
else
  STATUS=$?
fi

echo "$REPORT"
SUMMARY="$(echo "$REPORT" | tail -n 1)"
if [ "$STATUS" -eq 0 ]; then
  logger -t "$TAG" "Nightly check: $SUMMARY"
elif [ "$STATUS" -eq 1 ]; then
  alert "Correction integrity problems" "$REPORT"
  exit 1
else
  alert "Correction integrity check could not run" "$REPORT"
  exit "$STATUS"
fi
