#!/usr/bin/env bash
# Report linked git worktrees and whether each one looks safe to remove.
# Read-only: prints suggested `git worktree remove` commands, never runs them.
#
# A worktree is REMOVABLE when its directory exists and it has
#   - no tracked changes and no untracked files,
#   - no gitignored files other than regenerable trees (`git worktree remove`
#     deletes ignored files without --force, e.g. .env.local or local outputs),
#   - when its HEAD is detached, no commits missing from every branch (a
#     checked-out branch survives `git worktree remove`, so its commits are
#     never lost with the worktree, pushed or not),
#   - no lock, no Docker container started from it (compose working_dir) or
#     bind-mounting a path inside it,
#   - no process with its current directory inside it,
#   - no git activity (checkout, commit, index change) for WORKTREE_MIN_IDLE_DAYS.
# The git and docker checks fail closed: if git or docker cannot answer, the
# worktree is KEEP. The process check sees only processes whose working
# directory this user may read (all of them when run as root); run from a
# terminal, the report says how many it could not inspect. A removable branch
# worktree with commits on no remote branch (e.g. squash-merged, remote branch
# deleted) is annotated: the branch survives removal but is then their only copy.
# Anything else is KEEP with the reasons listed; an unlocked registered worktree
# whose directory is gone is PRUNE (`git worktree prune` cleans it up).
#
# Configuration (environment):
#   WORKTREE_REPORT_REPOS  - colon-separated repo paths to scan
#                            (default: every git repo directly under ~/projects)
#   WORKTREE_BACKUP_TREE   - directory backed up nightly; worktrees inside it are
#                            flagged (default: ~/projects)
#   WORKTREE_REPORT_DOCKER - docker command used to find compose working dirs
#                            (default: docker; skipped when not installed)
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

# Host paths bind-mounted into any container: `docker run -v <worktree>:/x`
# sets no compose label, so the working_dir label alone would miss it.
docker_bind_mount_sources() {
    local ids=""
    ids="$("$WORKTREE_REPORT_DOCKER" ps -aq 2>/dev/null)" || return 1
    [ -n "$ids" ] || return 0
    # shellcheck disable=SC2086
    "$WORKTREE_REPORT_DOCKER" inspect --format \
        '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' $ids 2>/dev/null
}

# "none" = docker not installed (no containers possible), "failed" = installed
# but could not be queried (daemon down, no socket access): fail closed.
docker_state="none"
if command -v "$WORKTREE_REPORT_DOCKER" >/dev/null 2>&1; then
    if docker_dirs="$("$WORKTREE_REPORT_DOCKER" ps -a --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null)" &&
        docker_mounts="$(docker_bind_mount_sources)"; then
        docker_state="ok"
        while IFS= read -r dir; do
            [ -n "$dir" ] && busy_dirs+=("container|$dir")
        done <<< "$docker_dirs"$'\n'"$docker_mounts"
    else
        docker_state="failed"
    fi
fi

# Gitignored trees that are safe to lose with the worktree (they are rebuilt,
# and the backup excludes them too). Any other ignored path keeps the worktree.
REGENERABLE_IGNORED='node_modules .venv .next __pycache__ .pytest_cache .ruff_cache .mypy_cache .tox next-env.d.ts'
# Repo-relative generated outputs of this repo's own builds (Prisma client, e2e fixtures).
REGENERABLE_IGNORED_PATHS='web/src/generated web/tests/e2e/fixtures'
# Only root can read every process's cwd; count the ones this user cannot.
unreadable_processes=0
for proc in /proc/[0-9]*; do
    if dir="$(readlink "$proc/cwd" 2>/dev/null)"; then
        [ -n "$dir" ] && busy_dirs+=("process|$dir")
    elif [ -d "$proc" ]; then
        unreadable_processes=$((unreadable_processes + 1))
    fi
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
# Any of those may be missing (--no-checkout has no index, reflogs can be off);
# prints nothing when none of them can be read.
last_git_activity() {
    local git_dir
    git_dir="$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null)" || return 0
    { stat -c %Y "$git_dir/HEAD" "$git_dir/index" "$git_dir/logs/HEAD" 2>/dev/null || true; } |
        sort -n | tail -n1
}

# Read `git status --porcelain -z --ignored` from stdin. Sets status_dirty=1
# when anything but ignored entries is listed and status_precious to the
# ignored paths (one per line) that are not regenerable trees. NUL-separated
# output keeps paths raw; the default output quotes non-ASCII and special
# characters, which would break the basename match.
status_dirty=0
status_precious=""
read_status() {
    local entry xy path name skip_source=0
    status_dirty=0
    status_precious=""
    while IFS= read -r -d '' entry; do
        if [ "$skip_source" = "1" ]; then
            # The record after a rename/copy is its source path.
            skip_source=0
            continue
        fi
        xy="${entry:0:2}"
        path="${entry:3}"
        case "$xy" in
            *R*|*C*) skip_source=1 ;;
        esac
        if [ "$xy" != '!!' ]; then
            status_dirty=1
            continue
        fi
        path="${path%/}"
        name="${path##*/}"
        [[ " $REGENERABLE_IGNORED " == *" $name "* || "$name" == *.pyc || "$name" == *.tsbuildinfo ]] && continue
        [[ " $REGENERABLE_IGNORED_PATHS " == *" $path "* ]] && continue
        status_precious+="$path"$'\n'
    done
    status_precious="${status_precious%$'\n'}"
}

status_tmp="$(mktemp)"
trap 'rm -f "$status_tmp"' EXIT

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
    local label reasons="" files="" active="unknown" active_epoch="" idle_days=0 where=""
    local unpushed="" unpushed_count="" precious_count=0 note=""
    local -a why=()

    if [ -n "$ref" ]; then
        label="branch ${ref#refs/heads/}"
    else
        label="detached ${head:0:8}"
    fi

    if [ "$missing" = "1" ] || [ ! -d "$path" ]; then
        if [ "$locked" = "1" ]; then
            # `git worktree prune` skips locked entries, so PRUNE advice would be a no-op.
            keep_rows+="  KEEP       $path  [$label]  -- directory missing but locked (git worktree unlock, then prune, if it is gone for good)"$'\n'
            kept=$((kept + 1))
        else
            prune_rows+="  PRUNE      $path  [$label]  directory missing"$'\n'
            prunable=$((prunable + 1))
        fi
        return 0
    fi

    [ "$locked" = "1" ] && why+=("locked")
    [ "$docker_state" = "failed" ] && why+=("Docker state unknown (docker ps failed)")
    while IFS= read -r reason; do
        [ -n "$reason" ] && why+=("$reason")
    done < <(busy_reasons "$path")

    if ! git -C "$path" status --porcelain -z --ignored > "$status_tmp" 2>/dev/null; then
        why+=("git status failed")
    else
        read_status < "$status_tmp"
        [ "$status_dirty" = "0" ] || why+=("uncommitted changes")
        if [ -n "$status_precious" ]; then
            precious_count="$(wc -l <<< "$status_precious")"
            why+=("$precious_count ignored path(s) that removal would delete, e.g. $(head -n1 <<< "$status_precious")")
        fi
    fi

    # A checked-out branch keeps its commits after `git worktree remove` (the
    # squash-merged PR worktrees this report exists for always have commits no
    # remote branch contains). Only a detached HEAD can hold commits that no
    # ref would point at any more.
    if [ -z "$ref" ]; then
        if ! unpushed="$(git -C "$path" rev-list -n1 HEAD --not --branches --remotes 2>/dev/null)"; then
            why+=("could not compare detached HEAD with branches")
        elif [ -n "$unpushed" ]; then
            why+=("detached HEAD with commits not on any branch")
        fi
    else
        # Not a reason to keep the worktree, but after removal the local branch
        # is the only copy of these commits, so say so.
        if ! unpushed_count="$(git -C "$path" rev-list --count HEAD --not --remotes 2>/dev/null)"; then
            note="  (could not compare with remote branches; the branch stays after removal)"
        elif [ "$unpushed_count" -gt 0 ]; then
            note="  (branch has $unpushed_count commit(s) on no remote branch; the branch stays after removal)"
        fi
    fi

    active_epoch="$(last_git_activity "$path")"
    if [ -z "$active_epoch" ]; then
        why+=("git activity unknown")
    else
        idle_days=$(( (now_epoch - active_epoch) / 86400 ))
        if [ "$idle_days" -lt "$WORKTREE_MIN_IDLE_DAYS" ]; then
            why+=("active in the last $WORKTREE_MIN_IDLE_DAYS days")
        fi
        active="$(date -d "@$active_epoch" +%F)"
    fi

    files="$(du --inodes -s -- "$path" 2>/dev/null | cut -f1)"
    if [ "$path" = "$WORKTREE_BACKUP_TREE" ] || [[ "$path" == "$WORKTREE_BACKUP_TREE"/* ]]; then
        where="  (inside backup tree)"
    fi

    if [ "${#why[@]}" -eq 0 ]; then
        removable_rows+="  REMOVABLE  $path  [$label, last active $active]  ${files:-?} files$where$note"$'\n'
        remove_commands+=("$(printf 'git -C %q worktree remove %q' "$repo" "$path")")
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
if [ "$docker_state" = "failed" ]; then
    echo "Note: '$WORKTREE_REPORT_DOCKER ps' failed, so no worktree is marked removable."
fi
# Only on a terminal: in the weekly email this would be the same line every
# week (root and system daemons), and the header documents the limitation.
if [ "$unreadable_processes" -gt 0 ] && [ -t 1 ]; then
    echo "Note: $unreadable_processes process(es) of other users could not be inspected; a worktree only they use is not detected (run as root for a complete check)."
fi
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
