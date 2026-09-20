#!/usr/bin/env bash
#
# Best-effort lookup of when web-v2-<hash> fingerprints (as reported by web
# clients and surfaced in the weekly report) were introduced, by
# recomputing the fingerprint for the tree at each commit that touched the
# production-input paths (see resolve_web_version.sh) until it matches.
#
# This finds when the fingerprint's SOURCE last changed, which is NOT the
# same as when it was deployed -- a deploy can lag the commit by days or
# weeks. Treat the result as a lower bound on a version's age, not the
# actual rollout date.
#
# Usage:
#   resolve_web_version_history.sh <web-v2-hash-or-bare-hash> [<hash> ...]
#
# Env:
#   REPO_ROOT      - repo checkout to search (default: repo containing this script)
#   MAX_CANDIDATES - how many of the most recent path-touching commits to
#                    scan (default: 3000)
#   APP_ENV, NEXT_PUBLIC_APP_URL, VAPID_PUBLIC_KEY, NEXT_PUBLIC_SUPPORT_EMAIL,
#   NEXT_PUBLIC_SUPPORT_EMAIL_B64, OAUTH_MOCK_URL
#                  - build-shaping values baked into the fingerprint; pass
#                    the current production values for the best
#                    approximation. They are assumed constant across the
#                    scanned history, which holds unless one of them changed
#                    recently.
#
# Output: one pipe-delimited line per requested hash, in the order given:
#   <hash>|FOUND|<commit>|<commit-iso-date>
#   <hash>|NOT_FOUND|<candidates-scanned>

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo_root="$(cd "$script_dir/.." && pwd)"
# shellcheck source=scripts/resolve_web_version.sh
source "$script_dir/resolve_web_version.sh"

if [ "$#" -eq 0 ]; then
  echo "usage: resolve_web_version_history.sh <web-v2-hash> [<hash> ...]" >&2
  exit 1
fi

repo_root="${REPO_ROOT:-$default_repo_root}"
max_candidates="${MAX_CANDIDATES:-3000}"

targets=()
for arg in "$@"; do
  case "$arg" in
    web-v2-*) targets+=("$arg") ;;
    *) targets+=("web-v2-$arg") ;;
  esac
done

if ! git -C "$repo_root" rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "Cannot resolve a tracked repository in $repo_root" >&2
  exit 1
fi

# Commits that touched a production-input path, oldest first among the most
# recent MAX_CANDIDATES -- the fingerprint can only change at these commits.
mapfile -t candidates < <(
  git -C "$repo_root" log --format=%H --reverse -- "${production_inputs[@]}" | tail -n "$max_candidates"
)

declare -A found_commit=()
declare -A found_date=()

for commit in "${candidates[@]}"; do
  fp="$(web_version_fingerprint "$repo_root" "$commit" || true)"

  for t in "${targets[@]}"; do
    if [ "$fp" = "$t" ] && [ -z "${found_commit[$t]+x}" ]; then
      found_commit[$t]="$commit"
      found_date[$t]="$(git -C "$repo_root" show -s --format=%cI "$commit")"
    fi
  done
done

for t in "${targets[@]}"; do
  if [ -n "${found_commit[$t]+x}" ]; then
    printf '%s|FOUND|%s|%s\n' "$t" "${found_commit[$t]}" "${found_date[$t]}"
  else
    printf '%s|NOT_FOUND|%s\n' "$t" "${#candidates[@]}"
  fi
done
