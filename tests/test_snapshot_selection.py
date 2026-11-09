"""Keep backups limited to declared data, using real rsync selection rules."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.helpers.linux_host_tools import requires_linux_host_tools

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "web/scripts/rsnapshot-backup.sh"
AUDIO_INCLUDE = REPO_ROOT / "web/setup/backup/audio.include"
linux_host = requires_linux_host_tools("flock", "date -d", "stat -c", "realpath -e")


@pytest.mark.skipif(shutil.which("rsync") is None, reason="requires rsync")
def test_audio_selection_preserves_generations_and_aliases_without_unknown_trees(
    tmp_path: Path,
) -> None:
    source = tmp_path / "audio"
    source.mkdir()
    selected = {
        "audio_archived_20251222_144441/hash/recording.webm": "archived recording",
        "audio_archived_20260221_120320/hash/recording.m4a": "second generation",
        "audio_archived_20301231_235959/nested/hash.webm": "future archive",
        "audio_staged_20251222_144441/hash.wav": "staged audio",
        "audio_staged_20301231_235959/nested/hash.audiohash": "future sidecar",
    }
    omitted = {
        "training/asr_smoke/adapter/adapter_model.safetensors": "model",
        "models/model.safetensors": "model",
        "experiments/recording.wav": "experiment",
        "unexpected_new_directory/recording.webm": "unknown purpose",
        "audio_archived_latest/recording.webm": "unrecognized name",
        "audio_archived_2026110_120000/recording.webm": "short date",
        "audio_archived_20261109_12000/recording.webm": "short time",
        "audio_staged_abcdefgh_123456/recording.wav": "invalid date",
        "audio_staged_20261109_abcdef/recording.wav": "invalid time",
        "model.safetensors": "unlisted root file",
        ".DS_Store": "unlisted root metadata",
    }
    for relative, content in (selected | omitted).items():
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    aliases = {
        "audio_archived": "audio_archived_20260221_120320",
        "audio_staged": "audio_staged_20301231_235959",
    }
    for alias, target in aliases.items():
        (source / alias).symlink_to(target, target_is_directory=True)

    destination = tmp_path / "snapshot"
    result = subprocess.run(
        [
            "rsync",
            "-a",
            f"--include-from={AUDIO_INCLUDE}",
            f"{source}/",
            f"{destination}/",
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    copied = {
        str(path.relative_to(destination))
        for path in destination.rglob("*")
        if path.is_file() or path.is_symlink()
    }
    assert copied == set(selected) | set(aliases)
    assert {path.name for path in destination.iterdir()} == {
        relative.split("/", 1)[0] for relative in selected
    } | set(aliases)
    for relative, content in selected.items():
        assert (destination / relative).read_text() == content
    for alias, target in aliases.items():
        assert (destination / alias).is_symlink()
        assert os.readlink(destination / alias) == target
        assert (destination / alias).is_dir()


def executable(path: Path, body: str) -> None:
    path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
    path.chmod(0o700)


@pytest.fixture
def runner_env(tmp_path: Path) -> dict[str, str]:
    mock_bin = tmp_path / "bin"
    mock_bin.mkdir()
    executable(
        mock_bin / "rsnapshot",
        'printf "rsnapshot:%s\\n" "$3" >>"$EVENTS"\n',
    )
    executable(mock_bin / "logger", "exit 0\n")
    hook = tmp_path / "hook.sh"
    executable(hook, 'printf "hook:%s\\n" "$1" >>"$EVENTS"\n')
    source = tmp_path / "source"
    source.mkdir()
    env = os.environ.copy()
    env.pop("SNAPSHOT_ENV_FILE", None)
    env.pop("SNAPSHOT_INTERVAL", None)
    env.update(
        SOURCE_DIR=str(source),
        SNAPSHOT_MAP_FILE=str(tmp_path / "extra.paths"),
        SNAPSHOT_ROOT=str(tmp_path / "snapshots"),
        RSNAPSHOT_CONFIG=str(tmp_path / "rsnapshot.conf"),
        LOG_FILE=str(tmp_path / "backup.log"),
        DETAIL_LOG_FILE=str(tmp_path / "detail.log"),
        LOCK_FILE=str(tmp_path / "lock"),
        RSNAPSHOT_LOCK_FILE=str(tmp_path / "snapshot.pid"),
        EXCLUDE_FILE="",
        ENABLE_REMOTE_SYNC="0",
        ALERT_EMAIL="",
        BEFORE_SNAPSHOT_HOOK=str(hook),
        AFTER_SYNC_HOOK=str(hook),
        EVENTS=str(tmp_path / "events"),
        RETAIN_DAILY="7",
        RETAIN_WEEKLY="4",
        RETAIN_MONTHLY="12",
        RETAIN_YEARLY="5",
        RSNAPSHOT_DRY_RUN="0",
        RSYNC_DRY_RUN="0",
        PATH=f"{mock_bin}:{env['PATH']}",
    )
    return env


def run_runner(env: dict[str, str], tmp_path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(RUNNER), "daily"],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=10,
    )


@linux_host
def test_per_source_allowlist_keeps_other_mapped_sources_unfiltered(
    tmp_path: Path, runner_env: dict[str, str]
) -> None:
    other = tmp_path / "database-dumps"
    other.mkdir()
    include = tmp_path / "audio.include"
    include.write_text("+ /audio_archived/***\n- *\n# trailing comment\n\n")
    Path(runner_env["SNAPSHOT_MAP_FILE"]).write_text(
        f"{runner_env['SOURCE_DIR']}|audio/besedy_audio|{include}\n{other}|state/db_dumps\n"
    )
    result = run_runner(runner_env, tmp_path)
    assert result.returncode == 0, result.stderr
    points = [
        line.split("\t")
        for line in Path(runner_env["RSNAPSHOT_CONFIG"]).read_text().splitlines()
        if line.startswith("backup\t")
    ]
    assert points == [
        [
            "backup",
            f"{runner_env['SOURCE_DIR']}/",
            "audio/besedy_audio/",
            f"include_file={include}",
        ],
        ["backup", f"{other}/", "state/db_dumps/"],
    ]
    assert Path(runner_env["EVENTS"]).read_text().splitlines() == [
        "hook:before",
        "rsnapshot:configtest",
        "rsnapshot:daily",
        "hook:after",
    ]


@linux_host
@pytest.mark.parametrize(
    "invalid",
    [
        "missing",
        "directory",
        "empty",
        "comments_only",
        "unreadable",
        "no_default_deny",
        "deny_not_last",
        "leading_deny_space",
        "trailing_deny_space",
        "leading_deny_tab",
        "relative",
        "space_in_path",
        "comma_in_path",
        "empty_third_field",
        "fourth_field",
    ],
)
def test_invalid_allowlist_fails_before_dump_or_snapshot_changes(
    tmp_path: Path, runner_env: dict[str, str], invalid: str
) -> None:
    include = tmp_path / "audio.include"
    include.write_text("+ /audio_archived/***\n- *\n")
    field = str(include)
    if invalid == "missing":
        include.unlink()
    elif invalid == "directory":
        include.unlink()
        include.mkdir()
    elif invalid == "empty":
        include.write_text("")
    elif invalid == "comments_only":
        include.write_text("# no active rules\n\n")
    elif invalid == "unreadable":
        include.chmod(0)
        if os.access(include, os.R_OK):
            pytest.skip("this user can read mode000 files")
    elif invalid == "no_default_deny":
        include.write_text("+ /audio_archived/***\n")
    elif invalid == "deny_not_last":
        include.write_text("- *\n+ /training/***\n")
    elif invalid in {"leading_deny_space", "trailing_deny_space", "leading_deny_tab"}:
        terminal_rule = {
            "leading_deny_space": " - *",
            "trailing_deny_space": "- * ",
            "leading_deny_tab": "\t- *",
        }[invalid]
        include.write_text(f"+ /audio_archived/***\n{terminal_rule}\n")
    elif invalid == "relative":
        field = include.name
    elif invalid in {"space_in_path", "comma_in_path"}:
        path = tmp_path / (
            "audio rules.include" if invalid == "space_in_path" else "audio,rules.include"
        )
        include.rename(path)
        field = str(path)
    elif invalid == "empty_third_field":
        field = ""
    elif invalid == "fourth_field":
        field += "|unexpected"

    Path(runner_env["SNAPSHOT_MAP_FILE"]).write_text(
        f"{runner_env['SOURCE_DIR']}|audio/besedy_audio|{field}\n"
    )
    config = Path(runner_env["RSNAPSHOT_CONFIG"])
    config.write_text("previous known-good configuration\n")
    result = run_runner(runner_env, tmp_path)
    assert result.returncode != 0, result.stdout
    assert not Path(runner_env["EVENTS"]).exists()
    assert config.read_text() == "previous known-good configuration\n"
    assert not Path(runner_env["SNAPSHOT_ROOT"]).exists()
