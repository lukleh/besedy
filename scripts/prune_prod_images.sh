#!/usr/bin/env bash
# Remove old besedy-web:<commit> and besedy-jobs:<commit> image tags.
#
# Usage: prune_prod_images.sh <keep-commit>...
#
# The caller (just prod-prune-images) passes the full commits to keep: the
# newest deployed ones, whose images `just prod-rollback` needs. This removes
# every other besedy-web / besedy-jobs tag whose tag is a full 40-hex commit,
# after listing them and asking. It never matches other repositories, the
# :prod tags or the GPU backend images, and it skips any image a container
# (running or stopped) was created from. Removing a tag only deletes the image
# once no other tag points at it.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <keep-commit>..." >&2
  exit 2
fi

keep=()
for commit in "$@"; do
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Not a full lowercase commit: $commit" >&2
    exit 2
  fi
  keep+=("$commit")
done

is_kept() {
  local sha="$1" k
  for k in "${keep[@]}"; do
    [[ "$k" == "$sha" ]] && return 0
  done
  return 1
}

remove=()
skipped_in_use=()
for repository in besedy-web besedy-jobs; do
  while IFS= read -r tag; do
    [[ "$tag" =~ ^(besedy-web|besedy-jobs):([0-9a-f]{40})$ ]] || continue
    is_kept "${BASH_REMATCH[2]}" && continue
    image_id="$(docker image inspect --format '{{.Id}}' "$tag")"
    if [[ -n "$(docker ps -a -q --filter "ancestor=$image_id")" ]]; then
      skipped_in_use+=("$tag")
      continue
    fi
    remove+=("$tag")
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' "$repository")
done

echo "Keeping the images of ${#keep[@]} deployed commit(s):"
printf '  %s\n' "${keep[@]}"
if ((${#skipped_in_use[@]} > 0)); then
  echo "Skipping tags whose image a container uses:"
  printf '  %s\n' "${skipped_in_use[@]}"
fi
if ((${#remove[@]} == 0)); then
  echo "Nothing to remove."
  exit 0
fi
echo "Will remove ${#remove[@]} tag(s):"
printf '  %s\n' "${remove[@]}"
echo "Rolling back to a commit outside the kept window becomes impossible."
read -r -p "Remove these tags? [y/N] " answer
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
  echo "Aborted; nothing was removed." >&2
  exit 1
fi

failed=0
for tag in "${remove[@]}"; do
  docker image rm "$tag" >/dev/null || {
    echo "Could not remove $tag" >&2
    failed=1
  }
done
echo "Removed $((${#remove[@]})) tag(s) (failures: $failed)."
exit "$failed"
