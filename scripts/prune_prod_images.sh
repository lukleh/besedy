#!/usr/bin/env bash
# Remove old besedy-web:<commit> and besedy-jobs:<commit> image tags.
#
# Usage: prune_prod_images.sh <keep-commit>...
#
# The caller (just prod-prune-images) passes the full commits to keep: the
# newest deployed ones, whose images `just prod-rollback` needs. This removes
# every other besedy-web / besedy-jobs tag whose tag is a full 40-hex commit,
# after listing them and asking. It never matches other repositories, the
# :prod tags or the GPU backend images, and it skips any image a :prod tag
# points at or a container (running or stopped) was created from. Removing a tag only deletes the image
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

# Images the :prod tags point at. prod-build retags the freshly built image
# as <commit> before prod-apply logs the deploy, so a build that is not in
# web_deploy_log yet is still protected here.
prod_ids=()
for prod_tag in besedy-web:prod besedy-jobs:prod; do
  if prod_id="$(docker image inspect --format '{{.Id}}' "$prod_tag" 2>/dev/null)"; then
    prod_ids+=("$prod_id")
  fi
done

is_prod_image() {
  local id="$1" p
  for p in "${prod_ids[@]}"; do
    [[ "$p" == "$id" ]] && return 0
  done
  return 1
}

remove=()
skipped=()
for repository in besedy-web besedy-jobs; do
  while IFS= read -r tag; do
    [[ "$tag" =~ ^(besedy-web|besedy-jobs):([0-9a-f]{40})$ ]] || continue
    is_kept "${BASH_REMATCH[2]}" && continue
    if ! image_id="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null)"; then
      echo "Skipping $tag: it disappeared while scanning." >&2
      continue
    fi
    if is_prod_image "$image_id"; then
      skipped+=("$tag")
      continue
    fi
    # A failed docker ps must stop the run, not read as "no container uses it".
    if ! users="$(docker ps -a -q --filter "ancestor=$image_id")"; then
      echo "docker ps failed; refusing to decide which images are in use." >&2
      exit 1
    fi
    if [[ -n "$users" ]]; then
      skipped+=("$tag")
      continue
    fi
    remove+=("$tag")
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' "$repository")
done

echo "Keeping the images of ${#keep[@]} deployed commit(s):"
printf '  %s\n' "${keep[@]}"
if ((${#skipped[@]} > 0)); then
  echo "Skipping tags whose image a :prod tag points at or a container uses:"
  printf '  %s\n' "${skipped[@]}"
fi
if ((${#remove[@]} == 0)); then
  echo "Nothing to remove."
  exit 0
fi
echo "Will remove ${#remove[@]} tag(s):"
printf '  %s\n' "${remove[@]}"
echo "Rolling back to a commit outside the kept window becomes impossible."
answer=""
read -r -p "Remove these tags? [y/N] " answer || true
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
  echo "Aborted; nothing was removed."
  exit 0
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
