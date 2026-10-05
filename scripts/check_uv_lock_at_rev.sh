#!/usr/bin/env bash
# Fail unless uv.lock matches pyproject.toml at <rev> (`uv lock --check`).
#
# Usage: check_uv_lock_at_rev.sh <rev>
#
# Run from inside the repository. It exports only the project files uv reads
# for locking from <rev> into a temporary directory, so it needs no checkout of
# <rev> and no network.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <rev>" >&2
  exit 2
fi
rev="$1"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# uv.toml and .python-version change what locking sees when they exist.
files=()
while IFS= read -r name; do
  files+=("$name")
done < <(git ls-tree --name-only "$rev" -- pyproject.toml uv.lock uv.toml .python-version)

for required in pyproject.toml uv.lock; do
  if [[ " ${files[*]} " != *" $required "* ]]; then
    echo "$required is missing at ${rev}; cannot verify the lock." >&2
    exit 1
  fi
done

git archive "$rev" -- "${files[@]}" | tar -x -C "$work_dir"

if ! output="$(cd "$work_dir" && uv lock --check 2>&1)"; then
  echo "uv lock --check failed for ${rev}: uv.lock is out of date with pyproject.toml, or could not be read." >&2
  echo "$output" >&2
  exit 1
fi
