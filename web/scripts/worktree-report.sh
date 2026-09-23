#!/usr/bin/env bash
# Report linked git worktrees and whether each one looks safe to remove.
# Read-only: prints suggested `git worktree remove` commands, never runs them.
#
# A worktree is REMOVABLE when its directory exists and it has
#   - no tracked changes and no untracked (non-ignored) files,
#   - no commits missing from every remote-tracking branch,
#   - no lock, no Docker container started from it (compose working_dir),
#   - no process with its current directory inside it,
#   - no git activity (checkout, commit, index change) for WORKTREE_MIN_IDLE_DAYS.
# Anything else is KEEP with the reasons listed; a registered worktree whose
# directory is gone is PRUNE (`git worktree prune` cleans it up).
#
# Configuration (environment):
#   WORKTREE_REPORT_REPOS  - colon-separated repo paths to scan
#                            (default: every git repo directly under ~/projects)
#   WORKTREE_BACKUP_TREE   - directory backed up nightly; worktrees inside it are
#                            flagged (default: ~/projects)
#   WORKTREE_REPORT_DOCKER - docker command used to find compose working dirs
#                            (default: docker; skipped when not available)
#   WORKTREE_MIN_IDLE_DAYS - days without git activity before a clean, pushed
#                            worktree counts as removable (default: 3)

set -euo pipefail

WORKTREE_BACKUP_TREE="${WORKTREE_BACKUP_TREE:-$HOME/projects}"
WORKTREE_REPORT_DOCKER="${WORKTREE_REPORT_DOCKER:-docker}"
WORKTREE_MIN_IDLE_DAYS="${WORKTREE_MIN_IDLE_DAYS:-3}"

case "$WORKTREE_MIN_IDLE_DAYS" in
    ''|*[!0-9]*)
        echo "WORKTREE_MIN_IDLE_DAYS must be a non-negative integer, got: $WORKTREE_MIN_IDLE_DAYS" >&2
        exit 1
        ;;
esac

# Read-only report: never let `git status` refresh (rewrite) a worktree index,
# which would also make the worktree look recently active.
export GIT_OPTIONAL_LOCKS=0

# Keep this script's own working directory out of the "in use" check.
cd /

declare -a repos=()
if [ -n "${WORKTREE_REPORT_REPOS:-}" ]; then
    IFS=':' read -r -a repos <<< "$WORKTREE_REPORT_REPOS"
else
    for candidate in "$HOME"/projects/*/; do
        # A .git directory marks a main checkout; linked worktrees have a .git file.
        [ -d "$candidate/.git" ] && repos+=("${candidate%/}")
    done
fi

declare -a busy_dirs=()
if command -v "$WORKTREE_REPORT_DOCKER" >/dev/null 2>&1; then
    while IFS= read -r dir; do
        [ -n "$dir" ] && busy_dirs+=("container|$dir")
    done < <("$WORKTREE_REPORT_DOCKER" ps -a --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u || true)
fi
for proc in /proc/[0-9]*; do
    dir="$(readlink "$proc/cwd" 2>/dev/null || true)"
    [ -n "$dir" ] && busy_dirs+=("process|$dir")
done

# Print the kinds of users (container, process) whose directory is inside $1.
busy_reasons() {
    local path="$1" entry kind dir
    local -A seen=()
    for entry in "${busy_dirs[@]}"; do
        kind="${entry%%|*}"
        dir="${entry#*|}"
        if [ "$dir" = "$path" ] || [[ "$dir" == "$path"/* ]]; then
            seen["$kind"]=1
        fi
    done
    [ -z "${seen[container]+x}" ] || printf '%s\n' "used by a Docker container"
    [ -z "${seen[process]+x}" ] || printf '%s\n' "a running process is inside it"
}

# Epoch of the newest git activity in a worktree: its HEAD, index, and reflog.
last_git_activity() {
    local git_dir
    git_dir="$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null)" || { echo 0; return 0; }
    stat -c %Y "$git_dir/HEAD" "$git_dir/index" "$git_dir/logs/HEAD" 2>/dev/null | sort -n | tail -n1
}

now_epoch="$(date +%s)"
removable_rows=""
keep_rows=""
prune_rows=""
declare -a remove_commands=()
removable=0
kept=0
prunable=0

report_worktree() {
    local repo="$1" path="$2" head="$3" ref="$4" locked="$5" missing="$6"
    local label reasons="" files="" active="" active_epoch=0 idle_days=0 where=""
    local -a why=()

    if [ -n "$ref" ]; then
        label="branch ${ref#refs/heads/}"
    else
        label="detached ${head:0:8}"
    fi

    if [ "$missing" = "1" ] || [ ! -d "$path" ]; then
        prune_rows+="  PRUNE      $path  [$label]  directory missing"$'\n'
        prunable=$((prunable + 1))
        return 0
    fi

    [ "$locked" = "1" ] && why+=("locked")
    while IFS= read -r reason; do
        [ -n "$reason" ] && why+=("$reason")
    done < <(busy_reasons "$path")
    if [ -n "$(git -C "$path" status --porcelain 2>/dev/null | head -n1)" ]; then
        why+=("uncommitted changes")
    fi
    if [ -n "$(git -C "$path" rev-list -n1 HEAD --not --remotes 2>/dev/null)" ]; then
        why+=("commits not on any remote branch")
    fi

    active_epoch="$(last_git_activity "$path")"
    active_epoch="${active_epoch:-0}"
    idle_days=$(( (now_epoch - active_epoch) / 86400 ))
    if [ "$idle_days" -lt "$WORKTREE_MIN_IDLE_DAYS" ]; then
        why+=("active in the last $WORKTREE_MIN_IDLE_DAYS days")
    fi
    active="$(date -d "@$active_epoch" +%F)"

    files="$(du --inodes -s -- "$path" 2>/dev/null | cut -f1)"
    if [ "$path" = "$WORKTREE_BACKUP_TREE" ] || [[ "$path" == "$WORKTREE_BACKUP_TREE"/* ]]; then
        where="  (inside backup tree)"
    fi

    if [ "${#why[@]}" -eq 0 ]; then
        removable_rows+="  REMOVABLE  $path  [$label, last active $active]  ${files:-?} files$where"$'\n'
        remove_commands+=("git -C $repo worktree remove $path")
        removable=$((removable + 1))
    else
        reasons="$(IFS=';'; echo "${why[*]}")"
        keep_rows+="  KEEP       $path  [$label, last active $active]  ${files:-?} files$where  -- ${reasons//;/, }"$'\n'
        kept=$((kept + 1))
    fi
}

scan_repo() {
    local repo="$1"
    local line path="" head="" ref="" locked=0 missing=0 first=1

    while IFS= read -r line || [ -n "$path" ]; do
        case "$line" in
            "worktree "*) path="${line#worktree }" ;;
            "HEAD "*) head="${line#HEAD }" ;;
            "branch "*) ref="${line#branch }" ;;
            locked|"locked "*) locked=1 ;;
            prunable|"prunable "*) missing=1 ;;
            "")
                if [ -n "$path" ]; then
                    # The first record is the main worktree, which is never removable.
                    [ "$first" = "1" ] || report_worktree "$repo" "$path" "$head" "$ref" "$locked" "$missing"
                    first=0
                fi
                path="" head="" ref="" locked=0 missing=0
                ;;
        esac
    done < <(git -C "$repo" worktree list --porcelain 2>/dev/null; echo)
}

for repo in "${repos[@]}"; do
    [ -n "$repo" ] && scan_repo "$repo"
done

total=$((removable + kept + prunable))
echo "Linked git worktrees: $total ($removable removable, $kept kept, $prunable with missing directories)"
[ "$total" -gt 0 ] || exit 0
printf '%s%s%s' "$removable_rows" "$keep_rows" "$prune_rows"

if [ "${#remove_commands[@]}" -gt 0 ]; then
    echo ""
    echo "To remove the removable worktrees:"
    printf '  %s\n' "${remove_commands[@]}"
fi
if [ "$prunable" -gt 0 ]; then
    echo ""
    echo "To forget worktrees whose directories are gone: git -C <repo> worktree prune"
fi
