#!/usr/bin/env bash
# Compatibility wrapper. Use weekly-report.sh directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/weekly-report.sh" "$@"
