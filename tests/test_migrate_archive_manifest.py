"""Explicit migration of known pre-AAC archive manifests, without runtime fallback."""

from __future__ import annotations

import csv
import json
import os
import shutil
import stat
import threading
from contextlib import contextmanager
from pathlib import Path

import pytest

import besedy.lib.data.atomic_io as atomic_io
from besedy.commands.catalog.archive import (
    ArchivedManifestWriter,
    ArchiveRequest,
    CompressedEntry,
    aac_manifest_values,
    catalog_ingest_lock,
    compress_audio_file,
    manifest_lock,
    manifest_row,
    run_aac_backfill,
)
from besedy.lib.workflow.common import CsvAudioRow
from scripts import migrate_archive_manifest as migration
from tests.helpers.audio import create_tone_wav

AAC_COLUMNS = list(aac_manifest_values(None, None, None))
LEGACY_COLUMNS = [name for name in ArchivedManifestWriter.FIELDNAMES if name not in AAC_COLUMNS]


def _write_csv(path: Path, columns: list[str], rows: list[list[str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        writer.writerows(rows)


def _read_csv(path: Path) -> list[list[str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.reader(handle, strict=True))


def test_dry_run_reports_conversion_without_changing_bytes(tmp_path: Path) -> None:
    path = tmp_path / "archived.csv"
    columns = list(reversed(LEGACY_COLUMNS))
    rows = [
        [f"value-{index}" for index in range(len(columns))],
        [""] * len(columns),
    ]
    rows[0][2] = 'Příliš žluťoučký, "kůň"\nsecond line\r\nthird line'
    _write_csv(path, columns, rows)
    before = path.read_bytes()

    plan = migration.migrate_archive_manifest(path)

    assert plan == {
        "apply": False,
        "manifest": str(path),
        "rows": len(rows),
        "add_columns": AAC_COLUMNS,
    }
    assert path.read_bytes() == before
    assert not list(tmp_path.glob(".besedy-tmp-*"))


def test_apply_preserves_cells_column_order_and_mode_and_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "archived.csv"
    columns = LEGACY_COLUMNS[3:] + LEGACY_COLUMNS[:3]
    rows = [["", 'část, "jedna"\nčást dvě', *[str(index) for index in range(8)]]]
    _write_csv(path, columns, rows)
    path.chmod(0o640)

    plan = migration.migrate_archive_manifest(path, apply=True)

    assert plan["add_columns"] == AAC_COLUMNS
    assert _read_csv(path) == [columns + AAC_COLUMNS, rows[0] + ["", "", ""]]
    assert stat.S_IMODE(path.stat().st_mode) == 0o640
    before = path.read_bytes()
    before_stat = path.stat()

    second = migration.migrate_archive_manifest(path, apply=True)

    assert second["add_columns"] == []
    assert second["rows"] == 1
    assert path.read_bytes() == before
    assert path.stat().st_ino == before_stat.st_ino
    assert path.stat().st_mtime_ns == before_stat.st_mtime_ns
    assert not list(tmp_path.glob(".besedy-tmp-*"))


@pytest.mark.parametrize("apply", [False, True])
def test_current_manifest_is_validated_without_rewriting(tmp_path: Path, apply: bool) -> None:
    path = tmp_path / "archived.csv"
    columns = list(reversed(ArchivedManifestWriter.FIELDNAMES))
    rows = [[f"kept-{index}" for index in range(len(columns))]]
    _write_csv(path, columns, rows)
    before = path.read_bytes()
    before_stat = path.stat()

    result = migration.migrate_archive_manifest(path, apply=apply)

    assert result["add_columns"] == []
    assert result["rows"] == 1
    assert path.read_bytes() == before
    assert path.stat().st_ino == before_stat.st_ino
    assert path.stat().st_mtime_ns == before_stat.st_mtime_ns


@pytest.mark.parametrize(
    "columns",
    [
        LEGACY_COLUMNS[:-1],
        LEGACY_COLUMNS + ["unexpected"],
        LEGACY_COLUMNS + [AAC_COLUMNS[0]],
        LEGACY_COLUMNS + AAC_COLUMNS[:2],
        LEGACY_COLUMNS[:-1] + [LEGACY_COLUMNS[0]],
        ["hash", *LEGACY_COLUMNS[1:]],
        [],
    ],
    ids=["missing", "extra", "one-aac", "two-aac", "duplicate", "case", "empty"],
)
def test_unknown_or_ambiguous_headers_are_refused_unchanged(
    tmp_path: Path, columns: list[str]
) -> None:
    path = tmp_path / "archived.csv"
    _write_csv(path, columns, [[""] * len(columns)])
    before = path.read_bytes()

    with pytest.raises((ValueError, csv.Error)):
        migration.migrate_archive_manifest(path, apply=True)

    assert path.read_bytes() == before
    assert not list(tmp_path.glob(".besedy-tmp-*"))


@pytest.mark.parametrize("current", [False, True], ids=["legacy", "current"])
@pytest.mark.parametrize("failure", ["short", "long", "unterminated", "invalid-quote"])
def test_invalid_rows_are_rejected_even_in_current_manifests(
    tmp_path: Path, current: bool, failure: str
) -> None:
    path = tmp_path / "archived.csv"
    columns = ArchivedManifestWriter.FIELDNAMES if current else LEGACY_COLUMNS
    _write_csv(path, columns, [["first valid row"] + [""] * (len(columns) - 1)])
    with path.open("a", encoding="utf-8", newline="") as handle:
        if failure in {"short", "long"}:
            csv.writer(handle).writerow([""] * (len(columns) + (-1 if failure == "short" else 1)))
        elif failure == "unterminated":
            handle.write('"unfinished quoted cell\n')
        else:
            handle.write('"quoted"not-a-delimiter,' + "," * (len(columns) - 2) + "\n")
    before = path.read_bytes()

    with pytest.raises((ValueError, csv.Error)):
        migration.migrate_archive_manifest(path, apply=True)

    assert path.read_bytes() == before
    assert not list(tmp_path.glob(".besedy-tmp-*"))


@pytest.mark.parametrize("apply", [False, True])
@pytest.mark.parametrize("dangling", [False, True], ids=["live", "dangling"])
def test_leaf_symlinks_are_refused_without_changing_target(
    tmp_path: Path, apply: bool, dangling: bool
) -> None:
    target = tmp_path / "target.csv"
    if not dangling:
        _write_csv(target, LEGACY_COLUMNS, [[""] * len(LEGACY_COLUMNS)])
    path = tmp_path / "archived.csv"
    path.symlink_to(target)
    before = target.read_bytes() if target.exists() else None

    with pytest.raises((ValueError, OSError)):
        migration.migrate_archive_manifest(path, apply=apply)

    assert path.is_symlink()
    assert (target.read_bytes() if target.exists() else None) == before
    assert not list(tmp_path.glob(".besedy-tmp-*"))


def test_concrete_manifest_under_symlinked_parent_can_be_migrated(tmp_path: Path) -> None:
    directory = tmp_path / "catalogs"
    directory.mkdir()
    alias = tmp_path / "catalogs-link"
    alias.symlink_to(directory, target_is_directory=True)
    path = alias / "archived.csv"
    row = [f"kept-{index}" for index in range(len(LEGACY_COLUMNS))]
    _write_csv(path, LEGACY_COLUMNS, [row])

    migration.migrate_archive_manifest(path, apply=True)

    assert alias.is_symlink()
    assert not path.is_symlink()
    expected = [LEGACY_COLUMNS + AAC_COLUMNS, row + ["", "", ""]]
    assert _read_csv(path) == expected
    assert _read_csv(directory / path.name) == expected
    assert not list(directory.glob(".besedy-tmp-*"))


@pytest.mark.parametrize("lock_name", ["manifest_lock", "catalog_ingest_lock"])
def test_migration_waits_for_active_writer_and_preserves_its_appended_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, lock_name: str
) -> None:
    path = tmp_path / "audio_catalog_20260101_000000_loudness_archived.csv"
    rows = [
        [
            "a" * 64,
            "/original/a.wav",
            "/archive/a.webm",
            "opus",
            "48",
            "1000",
            "100",
            "10.0",
            "00:00:02",
            "",
        ],
        [
            "b" * 64,
            "/original/b.wav",
            "/archive/b.webm",
            "opus",
            "48",
            "2000",
            "200",
            "10.0",
            "00:00:03",
            "",
        ],
    ]
    _write_csv(path, LEGACY_COLUMNS, [rows[0]])
    before = path.read_bytes()
    real_lock = manifest_lock if lock_name == "manifest_lock" else catalog_ingest_lock
    attempted = threading.Event()
    finished = threading.Event()
    errors: list[BaseException] = []
    results: list[dict[str, object]] = []

    @contextmanager
    def observed_lock(manifest: Path):
        attempted.set()
        with real_lock(manifest):
            yield

    monkeypatch.setattr(migration, lock_name, observed_lock)

    def migrate() -> None:
        try:
            results.append(migration.migrate_archive_manifest(path, apply=True))
        except BaseException as error:
            errors.append(error)
        finally:
            finished.set()

    worker = threading.Thread(target=migrate, daemon=True)
    try:
        with real_lock(path):
            worker.start()
            assert attempted.wait(timeout=5), "migration did not reach the writer's lock"
            assert not finished.wait(timeout=0.15), "migration ignored the active writer's lock"
            assert path.read_bytes() == before
            assert not list(tmp_path.glob(".besedy-tmp-*"))
            with path.open("a", encoding="utf-8", newline="") as handle:
                csv.writer(handle).writerow(rows[1])
    finally:
        if worker.ident is not None:
            worker.join(timeout=5)
            assert not worker.is_alive(), "migration did not finish after releasing the lock"
        if errors:
            raise errors[0]

    assert results[0]["rows"] == 2
    assert _read_csv(path) == [LEGACY_COLUMNS + AAC_COLUMNS, *[row + ["", "", ""] for row in rows]]
    assert not list(tmp_path.glob(".besedy-tmp-*"))


@pytest.mark.parametrize("kind", ["missing", "directory", "fifo"])
def test_nonregular_manifest_paths_are_refused(tmp_path: Path, kind: str) -> None:
    path = tmp_path / "archived.csv"
    if kind == "directory":
        path.mkdir()
    elif kind == "fifo":
        os.mkfifo(path)

    with pytest.raises((ValueError, OSError)):
        migration.migrate_archive_manifest(path, apply=True)

    assert not list(tmp_path.glob(".besedy-tmp-*"))


def test_failed_atomic_publication_retains_original_and_removes_temporary_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "archived.csv"
    _write_csv(path, LEGACY_COLUMNS, [[""] * len(LEGACY_COLUMNS)])
    before = path.read_bytes()

    def fail_fsync(_fd: int) -> None:
        raise OSError("storage sync failed")

    monkeypatch.setattr(atomic_io, "_fsync_file", fail_fsync)

    with pytest.raises(OSError, match="storage sync failed"):
        migration.migrate_archive_manifest(path, apply=True)

    assert path.read_bytes() == before
    assert not list(tmp_path.glob(".besedy-tmp-*"))


def test_cli_defaults_to_dry_run_then_applies_explicitly(tmp_path: Path, capsys) -> None:
    path = tmp_path / "archived.csv"
    _write_csv(path, LEGACY_COLUMNS, [[""] * len(LEGACY_COLUMNS)])
    before = path.read_bytes()

    assert migration.main([str(path)]) == 0
    dry_run = json.loads(capsys.readouterr().out)
    assert dry_run["apply"] is False
    assert dry_run["rows"] == 1
    assert path.read_bytes() == before

    assert migration.main([str(path), "--apply"]) == 0
    applied = json.loads(capsys.readouterr().out)
    assert applied["apply"] is True
    assert applied["add_columns"] == AAC_COLUMNS
    assert _read_csv(path)[0] == ArchivedManifestWriter.FIELDNAMES


def test_cli_reports_failure_without_partial_conversion(tmp_path: Path, capsys) -> None:
    path = tmp_path / "archived.csv"
    path.write_text("Hash,Unknown\na,b\n", encoding="utf-8")
    before = path.read_bytes()

    with pytest.raises(SystemExit) as error:
        migration.main([str(path), "--apply"])

    assert error.value.code == 1
    output = capsys.readouterr()
    assert output.err
    assert not output.out
    assert path.read_bytes() == before


def test_migrated_reordered_manifest_accepts_new_archive_entries(tmp_path: Path) -> None:
    path = tmp_path / "archived.csv"
    columns = list(reversed(LEGACY_COLUMNS))
    old_row = [f"kept-{index}" for index in range(len(columns))]
    _write_csv(path, columns, [old_row])
    migration.migrate_archive_manifest(path, apply=True)
    entry = CompressedEntry(
        audio_hash="b" * 64,
        source=tmp_path / "nová, nahrávka.wav",
        compressed=tmp_path / "nová.webm",
        format="opus",
        bitrate_kbps=48,
        source_size_bytes=1000,
        compressed_size_bytes=100,
        compression_ratio=10,
        duration_seconds=2,
    )

    writer = ArchivedManifestWriter(path, append=True)
    writer.write_entry(entry)
    writer.close()

    records = _read_csv(path)
    assert records[0] == columns + AAC_COLUMNS
    assert records[1] == old_row + ["", "", ""]
    assert dict(zip(records[0], records[2], strict=True)) == {
        key: str(value) for key, value in manifest_row(entry).items()
    }


@pytest.mark.integration
def test_migrated_legacy_manifest_runs_real_aac_backfill(tmp_path: Path, require_ffmpeg) -> None:
    if not shutil.which("ffprobe"):
        pytest.skip("ffprobe not available")
    source = create_tone_wav(tmp_path / "talk.wav", duration_seconds=2)
    row = CsvAudioRow(audio_hash="a" * 64, full_path=str(source), duration_seconds=2)
    webm = tmp_path / "talk.webm"
    compressed = compress_audio_file(
        row,
        webm,
        format="opus",
        quality="low",
        stereo=False,
        ffmpeg_binary="ffmpeg",
        ffprobe_binary="ffprobe",
        use_fdk=False,
    )
    assert compressed.skipped is None, compressed.skipped
    assert compressed.compressed is not None
    aac = webm.with_suffix(".m4a")
    assert webm.is_file() and not aac.exists()
    path = tmp_path / "audio_catalog_20260101_000000_loudness_archived.csv"
    original = manifest_row(compressed.compressed)
    _write_csv(path, LEGACY_COLUMNS, [[str(original[name]) for name in LEGACY_COLUMNS]])

    migration.migrate_archive_manifest(path, apply=True)
    assert run_aac_backfill(ArchiveRequest(parallel=1), [row], path) == 0

    assert aac.is_file() and aac.stat().st_size > 0
    records = _read_csv(path)
    updated = dict(zip(records[0], records[1], strict=True))
    assert {name: updated[name] for name in LEGACY_COLUMNS} == {
        name: str(original[name]) for name in LEGACY_COLUMNS
    }
    assert updated["Compressed AAC Path"] == str(aac)
    assert updated["Compressed AAC Size (bytes)"] == str(aac.stat().st_size)
    assert int(updated["Compressed AAC Bitrate (kbps)"]) > 0
