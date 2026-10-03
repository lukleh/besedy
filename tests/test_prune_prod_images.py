"""scripts/prune_prod_images.sh against a stubbed docker."""

import os
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT_ROOT / "scripts" / "prune_prod_images.sh"
JUSTFILE = PROJECT_ROOT / "Justfile"

A, B, C, D, E = (ch * 40 for ch in "abcde")

# FAKE_TAGS: one repo:tag per line. FAKE_SHARED: "tag=image-id" overrides (default
# is an id unique to the tag). FAKE_IN_USE: image ids a container was created
# from. Every call is appended to FAKE_LOG; `image rm` of FAKE_RM_FAIL fails.
DOCKER_STUB = """#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "image ls")
    repo="${@: -1}"
    grep "^$repo:" <<< "$FAKE_TAGS" || true
    ;;
  "image inspect")
    tag="${@: -1}"
    id="$(grep "^$tag=" <<< "$FAKE_SHARED" | cut -d= -f2 || true)"
    echo "${id:-sha256:$tag}"
    ;;
  "ps -a")
    ancestor="${@: -1}"
    ancestor="${ancestor#ancestor=}"
    for used in $FAKE_IN_USE; do
      [[ "$used" == "$ancestor" ]] && echo "container1"
    done
    ;;
  "image rm")
    if [[ " $FAKE_RM_FAIL " == *" ${@: -1} "* ]]; then exit 1; fi
    ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
"""


def _run(
    tmp_path: Path, answer: str | None, keep: list[str], **env: str
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(DOCKER_STUB, encoding="utf-8")
    docker.chmod(0o755)
    log = tmp_path / "docker.log"
    log.write_text("", encoding="utf-8")
    result = subprocess.run(
        ["bash", str(SCRIPT), *keep],
        input=answer,
        env={
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "FAKE_LOG": str(log),
            "FAKE_TAGS": "",
            "FAKE_SHARED": "",
            "FAKE_IN_USE": "",
            "FAKE_RM_FAIL": "",
            **env,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    removed = [
        line.split()[-1]
        for line in log.read_text(encoding="utf-8").splitlines()
        if line.startswith("image rm ")
    ]
    return result, removed


TAGS = "\n".join(
    [
        f"besedy-web:{A}",
        f"besedy-web:{B}",
        f"besedy-web:{C}",
        f"besedy-web:{D}",
        "besedy-web:prod",
        "besedy-web:latest",
        "besedy-web:abc123",
        f"besedy-jobs:{A}",
        f"besedy-jobs:{B}",
        f"besedy-jobs:{E}",
        "besedy-jobs:prod",
        f"besedy-web-extra:{E}",
    ]
)


def test_removes_only_old_full_commit_tags_of_the_two_repositories(tmp_path: Path) -> None:
    result, removed = _run(tmp_path, "y\n", [A, B], FAKE_TAGS=TAGS)

    assert result.returncode == 0, result.stderr
    assert sorted(removed) == sorted(
        [f"besedy-web:{C}", f"besedy-web:{D}", f"besedy-jobs:{E}"]
    )


def test_keeps_both_tags_of_every_kept_commit_and_the_prod_tags(tmp_path: Path) -> None:
    _, removed = _run(tmp_path, "y\n", [A, B, C, D, E], FAKE_TAGS=TAGS)

    assert removed == []


def test_answering_no_removes_nothing(tmp_path: Path) -> None:
    result, removed = _run(tmp_path, "n\n", [A], FAKE_TAGS=TAGS)

    assert result.returncode == 1
    assert removed == []
    assert f"besedy-web:{B}" in result.stdout
    assert "Aborted" in result.stderr


def test_no_answer_removes_nothing(tmp_path: Path) -> None:
    result, removed = _run(tmp_path, "", [A], FAKE_TAGS=TAGS)

    assert result.returncode == 1
    assert removed == []


def test_skips_a_tag_whose_image_a_container_uses(tmp_path: Path) -> None:
    result, removed = _run(
        tmp_path,
        "y\n",
        [A],
        FAKE_TAGS=TAGS,
        # The container runs an image that the old tag C also points at.
        FAKE_SHARED=f"besedy-web:{C}=sha256:in-use",
        FAKE_IN_USE="sha256:in-use",
    )

    assert result.returncode == 0, result.stderr
    assert f"besedy-web:{C}" not in removed
    assert f"besedy-web:{C}" in result.stdout.split("Skipping")[1].split("Will remove")[0]
    assert f"besedy-web:{B}" in removed


def test_nothing_to_remove_does_not_prompt(tmp_path: Path) -> None:
    result, removed = _run(tmp_path, None, [A], FAKE_TAGS=f"besedy-web:{A}\nbesedy-web:prod")

    assert result.returncode == 0, result.stderr
    assert "Nothing to remove" in result.stdout
    assert removed == []


def test_a_failed_removal_is_reported_and_the_rest_continue(tmp_path: Path) -> None:
    result, removed = _run(
        tmp_path, "y\n", [A], FAKE_TAGS=TAGS, FAKE_RM_FAIL=f"besedy-web:{B}"
    )

    assert result.returncode == 1
    assert f"Could not remove besedy-web:{B}" in result.stderr
    assert f"besedy-web:{C}" in removed


@pytest.mark.parametrize("bad", ["abc123", "A" * 40, "g" * 40, A + "0"])
def test_keep_arguments_must_be_full_lowercase_commits(tmp_path: Path, bad: str) -> None:
    result, removed = _run(tmp_path, "y\n", [A, bad], FAKE_TAGS=TAGS)

    assert result.returncode == 2
    assert removed == []


def test_at_least_one_commit_is_required(tmp_path: Path) -> None:
    result, removed = _run(tmp_path, "y\n", [], FAKE_TAGS=TAGS)

    assert result.returncode == 2
    assert removed == []


def test_recipe_refuses_a_window_below_one_and_an_empty_deploy_log() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "prod-prune-images keep=" in justfile
    assert "^[1-9][0-9]*$" in justfile
    assert "web_deploy_log has no deploys; refusing" in justfile
    assert "docker image prune" not in justfile
