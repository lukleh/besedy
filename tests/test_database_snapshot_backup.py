"""Exercise the daily dump/NAS hooks without production Docker or NAS writes."""

from __future__ import annotations

import gzip
import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from tests.helpers.linux_host_tools import requires_linux_host_tools

REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK = REPO_ROOT / "web/scripts/db-snapshot-hook.sh"


def executable(path: Path, body: str) -> None:
    path.write_text("#!/usr/bin/env bash\nset -eu\n" + body, encoding="utf-8")
    path.chmod(0o700)


# The backup scripts run on the Linux prod host only.
linux_host = requires_linux_host_tools("flock", "date -d", "stat -c", "realpath -e")


@pytest.fixture
def backup_env(tmp_path: Path) -> dict[str, str]:
    project = tmp_path / "project"
    scripts = project / "scripts"
    scripts.mkdir(parents=True)
    (project / "web").mkdir()
    backup = tmp_path / "backups"
    backup.mkdir()
    remote = tmp_path / "remote"
    remote.mkdir()
    password = tmp_path / "password"
    password.write_text("fixture-only\n")
    ops = tmp_path / "ops.env"
    ops.write_text(
        f"BACKUP_DIR='{backup}'\n"
        "DB_BACKUP_REMOTE_TARGET=fixture::backups/extra/\n"
        f"DB_BACKUP_PASSWORD_FILE='{password}'\n"
        "DB_BACKUP_MAX_AGE_HOURS=24\n"
    )
    executable(scripts / "resolve_ops_env_file.sh", 'echo "$BESEDY_OPS_ENV"\n')
    executable(
        scripts / "run_web_compose.sh",
        """if [ "$2" = config ]; then
    printf '{"services":{"backup":{"volumes":[{"target":"/backups","source":"%s"}]}}}\n' "$BACKUP_DIR"
else
    [ "${FAKE_DUMP_FAIL:-0}" != 1 ] || exit 42
    for arg in "$@"; do
        case "$arg" in BACKUP_FILENAME=*) name="${arg#*=}";; esac
    done
    printf 'COPY public.catalog_entry fixture;\n' | gzip >"$BACKUP_DIR/$name"
fi
""",
    )
    mock_bin = tmp_path / "bin"
    mock_bin.mkdir()
    executable(
        mock_bin / "rsync",
        """args=("$@")
source="${args[${#args[@]}-2]}"
destination="${args[${#args[@]}-1]}"
case "${FAKE_RSYNC_MODE:-ok}" in
    missing) exit 23;;
    corrupt) printf 'not gzip' >"$destination";;
    changed) printf 'other valid SQL' | gzip >"$destination";;
    *) cp "$FAKE_REMOTE_DIR/${source##*/}" "$destination";;
esac
""",
    )
    env = os.environ.copy()
    env.update(
        BESEDY_COMPOSE_DIR=str(project / "web"),
        BESEDY_OPS_ENV=str(ops),
        BACKUP_DIR=str(backup),
        SNAPSHOT_ROOT=str(tmp_path / "snapshots"),
        SYNC_TARGET="fixture::backups/extra/",
        SNAPSHOT_INTERVAL="daily",
        ENABLE_REMOTE_SYNC="1",
        FAKE_REMOTE_DIR=str(remote),
        PATH=f"{mock_bin}:{env['PATH']}",
        TMPDIR=str(tmp_path),
    )
    return env


def run_hook(env: dict[str, str], phase: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(HOOK), phase], env=env, capture_output=True, text=True, timeout=10
    )


def prepare_snapshot(env: dict[str, str]) -> Path:
    result = run_hook(env, "before")
    assert result.returncode == 0, result.stderr
    backup = Path(env["BACKUP_DIR"])
    name = (backup / ".nas-pending.tsv").read_text().split("\t")[0]
    snapshot = Path(env["SNAPSHOT_ROOT"]) / "daily.0/state/db_dumps"
    snapshot.mkdir(parents=True)
    shutil.copy2(backup / name, snapshot / name)
    shutil.copy2(backup / name, Path(env["FAKE_REMOTE_DIR"]) / name)
    return backup


@linux_host
def test_dump_snapshot_readback_and_health_check(backup_env: dict[str, str]) -> None:
    backup = prepare_snapshot(backup_env)
    result = run_hook(backup_env, "after")
    assert result.returncode == 0, result.stderr
    assert not (backup / ".nas-pending.tsv").exists()
    assert (backup / ".nas-verified.tsv").stat().st_mode & 0o777 == 0o600
    assert run_hook(backup_env, "check").returncode == 0
    assert not list(Path(backup_env["TMPDIR"]).glob("besedy-db-nas-check.*"))


@linux_host
@pytest.mark.parametrize("mode", ["missing", "corrupt", "changed"])
def test_bad_nas_copy_never_marks_verified(backup_env: dict[str, str], mode: str) -> None:
    backup = prepare_snapshot(backup_env)
    backup_env["FAKE_RSYNC_MODE"] = mode
    assert run_hook(backup_env, "after").returncode != 0
    assert not (backup / ".nas-verified.tsv").exists()
    assert not list(Path(backup_env["TMPDIR"]).glob("besedy-db-nas-check.*"))


@linux_host
def test_missing_snapshot_cannot_claim_success(backup_env: dict[str, str]) -> None:
    assert run_hook(backup_env, "before").returncode == 0
    assert run_hook(backup_env, "after").returncode != 0


@linux_host
def test_failed_dump_invalidates_previous_pending_receipt(backup_env: dict[str, str]) -> None:
    backup = prepare_snapshot(backup_env)
    backup_env["FAKE_DUMP_FAIL"] = "1"
    assert run_hook(backup_env, "before").returncode != 0
    assert not (backup / ".nas-pending.tsv").exists()
    assert run_hook(backup_env, "after").returncode != 0


@linux_host
def test_overdue_receipt_fails_at_24_hours(backup_env: dict[str, str]) -> None:
    backup = prepare_snapshot(backup_env)
    assert run_hook(backup_env, "after").returncode == 0
    receipt = backup / ".nas-verified.tsv"
    fields = receipt.read_text().rstrip("\n").split("\t")
    fields[1] = str(int(time.time()) - 24 * 3600 - 1)
    receipt.write_text("\t".join(fields) + "\n")
    result = run_hook(backup_env, "check")
    assert result.returncode != 0
    assert "overdue" in result.stderr


@linux_host
def test_missing_receipt_and_changed_target_fail(backup_env: dict[str, str]) -> None:
    assert run_hook(backup_env, "check").returncode != 0
    prepare_snapshot(backup_env)
    assert run_hook(backup_env, "after").returncode == 0
    with Path(backup_env["BESEDY_OPS_ENV"]).open("a") as ops:
        ops.write("DB_BACKUP_REMOTE_TARGET=fixture::other/\n")
    assert run_hook(backup_env, "check").returncode != 0


@linux_host
@pytest.mark.parametrize("failed_phase", ["before", "after", "none"])
@pytest.mark.parametrize("via_config", [False, True])
@pytest.mark.parametrize("interval", ["daily", "weekly", "monthly", "yearly"])
def test_hook_failure_does_not_skip_data_snapshot(
    tmp_path: Path, failed_phase: str, via_config: bool, interval: str
) -> None:
    driver = REPO_ROOT / "web/scripts/rsnapshot-backup.sh"
    mock_bin = tmp_path / "bin"
    mock_bin.mkdir()
    events = tmp_path / "events"
    executable(
        mock_bin / "rsnapshot",
        'if [ "$3" != configtest ]; then echo snapshot >>"$EVENTS"; fi\n',
    )
    executable(mock_bin / "logger", "exit 0\n")
    hook = tmp_path / "hook.sh"
    executable(hook, 'echo "$1" >>"$EVENTS"\n[ "$1" != "$FAILED_PHASE" ]\n')
    env = os.environ.copy()
    env.pop("SNAPSHOT_ENV_FILE", None)
    env.pop("SNAPSHOT_INTERVAL", None)
    source = tmp_path / "source with spaces"
    source.mkdir()
    env.update(
        SOURCE_DIR=str(source),
        SNAPSHOT_MAP_FILE="",
        SNAPSHOT_ROOT=str(tmp_path / "snapshots"),
        RSNAPSHOT_CONFIG=str(tmp_path / "rsnapshot.conf"),
        LOG_FILE=str(tmp_path / "log"),
        DETAIL_LOG_FILE=str(tmp_path / "detail.log"),
        LOCK_FILE=str(tmp_path / "lock"),
        RSNAPSHOT_LOCK_FILE=str(tmp_path / "rsnapshot.pid"),
        EXCLUDE_FILE="",
        ENABLE_REMOTE_SYNC="0",
        ALERT_EMAIL="",
        BEFORE_SNAPSHOT_HOOK=str(hook),
        AFTER_SYNC_HOOK=str(hook),
        EVENTS=str(events),
        FAILED_PHASE=failed_phase,
        RSNAPSHOT_DRY_RUN="0",
        RSYNC_DRY_RUN="0",
        PATH=f"{mock_bin}:{env['PATH']}",
    )
    if via_config:
        config_keys = (
            "SOURCE_DIR",
            "SNAPSHOT_ROOT",
            "RSNAPSHOT_CONFIG",
            "LOG_FILE",
            "DETAIL_LOG_FILE",
            "LOCK_FILE",
            "RSNAPSHOT_LOCK_FILE",
            "EXCLUDE_FILE",
            "ENABLE_REMOTE_SYNC",
            "ALERT_EMAIL",
            "BEFORE_SNAPSHOT_HOOK",
            "AFTER_SYNC_HOOK",
        )
        profile = tmp_path / "private profile.env"
        profile.write_text(
            "\n".join(f"{key}={shlex.quote(env.pop(key))}" for key in config_keys) + "\n"
        )
        env["SNAPSHOT_ENV_FILE"] = str(profile)
    result = subprocess.run(["bash", str(driver), interval], env=env, capture_output=True)
    expected = ["before", "snapshot", "after"] if interval == "daily" else ["snapshot"]
    assert events.read_text().splitlines() == expected
    assert result.returncode == (1 if interval == "daily" and failed_phase != "none" else 0)


def test_runner_requires_explicit_host_paths() -> None:
    driver = REPO_ROOT / "web/scripts/rsnapshot-backup.sh"
    result = subprocess.run(
        ["bash", str(driver), "daily"],
        env={"PATH": os.environ["PATH"]},
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "Set SNAPSHOT_ROOT" in result.stderr


def test_runner_rejects_missing_private_profile(tmp_path: Path) -> None:
    driver = REPO_ROOT / "web/scripts/rsnapshot-backup.sh"
    result = subprocess.run(
        ["bash", str(driver), "daily"],
        env={"PATH": os.environ["PATH"], "SNAPSHOT_ENV_FILE": str(tmp_path / "missing.env")},
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "configuration is missing or unreadable" in result.stderr


def test_compose_dump_is_atomic_and_one_shot(tmp_path: Path) -> None:
    # Extract the literal shell block; translate Compose dollar escaping and
    # redirect all paths into this fixture, with a fake pg_dump on PATH.
    compose = (REPO_ROOT / "web/docker-compose.yml").read_text()
    section = compose.split("  backup:\n", 1)[1]
    command = section.split("      - |\n", 1)[1].split("    # The host's", 1)[0]
    command = command.replace("$$", "$").replace("/backups", str(tmp_path / "backups"))
    backup = tmp_path / "backups"
    backup.mkdir()
    mock_bin = tmp_path / "bin"
    mock_bin.mkdir()
    executable(mock_bin / "pg_dump", "printf 'SQL fixture\\n'\n")
    env = os.environ.copy()
    env.update(PATH=f"{mock_bin}:{env['PATH']}", BACKUP_FILENAME="besedy_20000101_120000.sql.gz")
    result = subprocess.run(["sh", "-c", command], env=env, capture_output=True, timeout=5)
    assert result.returncode == 0, result.stderr
    archive = backup / env["BACKUP_FILENAME"]
    assert gzip.decompress(archive.read_bytes()) == b"SQL fixture\n"
    assert archive.stat().st_mode & 0o777 == 0o600
    # A collision must not overwrite an existing dump; invalid names are rejected.
    assert subprocess.run(["sh", "-c", command], env=env, capture_output=True).returncode != 0
    env["BACKUP_FILENAME"] = "../unsafe.sql.gz"
    assert subprocess.run(["sh", "-c", command], env=env, capture_output=True).returncode != 0
    assert not list(backup.glob("*.tmp"))
    executable(mock_bin / "pg_dump", "printf 'partial SQL\\n'\nexit 42\n")
    env["BACKUP_FILENAME"] = "besedy_20000101_120001.sql.gz"
    assert subprocess.run(["sh", "-c", command], env=env, capture_output=True).returncode != 0
    assert not (backup / env["BACKUP_FILENAME"]).exists()
    assert not list(backup.glob("*.tmp"))
    assert gzip.decompress(archive.read_bytes()) == b"SQL fixture\n"
