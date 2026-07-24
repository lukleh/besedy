"""Identity-contract tests for catalog and standalone hashing."""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
from pathlib import Path

import pytest

from besedy.commands.catalog import add as add_command
from besedy.commands.catalog import hash as hash_command
from besedy.commands.catalog import merge as merge_command
from besedy.lib.catalog import manager


def test_catalog_rejects_decode_failure_without_sidecar(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "broken.mp3"
    source.write_bytes(b"not audio")
    monkeypatch.setattr(manager, "audio_content_sha256sum", lambda _path: None)

    record, error, warning = manager.build_record_for_file(source)

    assert record is None
    assert error is not None
    assert "file was not added to the catalog" in error
    assert warning is None
    assert not Path(f"{source}.audiohash").exists()


def test_catalog_writes_typed_audio_sidecar(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "valid.wav"
    source.write_bytes(b"audio container")
    audio_hash = "a" * 64
    monkeypatch.setattr(manager, "audio_content_sha256sum", lambda _path: audio_hash)

    record, error, warning = manager.build_record_for_file(source)

    assert error is None
    assert warning is None
    assert record is not None
    assert record.hash == audio_hash
    assert record.hash_algorithm == manager.AUDIO_HASH_ALGORITHM
    sidecar = Path(f"{source}.audiohash").read_text(encoding="utf-8")
    assert sidecar.splitlines() == [
        f"{audio_hash}  {source.name}",
        f"{manager.AUDIO_HASH_ALGORITHM_MARKER} {manager.AUDIO_HASH_ALGORITHM}",
        f"{manager.SOURCE_FILE_SHA256_MARKER} {hashlib.sha256(source.read_bytes()).hexdigest()}",
    ]


def test_catalog_recomputes_untyped_audio_sidecar(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "untyped.mp3"
    source.write_bytes(b"source bytes")
    untyped_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    sidecar = Path(f"{source}.audiohash")
    sidecar.write_text(f"{untyped_hash}  {source.name}\n", encoding="utf-8")
    os.utime(sidecar, (source.stat().st_mtime + 1, source.stat().st_mtime + 1))
    canonical_hash = "b" * 64
    calls: list[Path] = []

    def compute_audio_hash(path: Path) -> str:
        calls.append(path)
        return canonical_hash

    monkeypatch.setattr(manager, "audio_content_sha256sum", compute_audio_hash)

    record, error, _warning = manager.build_record_for_file(source)

    assert error is None
    assert record is not None
    assert record.hash == canonical_hash
    assert calls == [source]
    assert manager.AUDIO_HASH_ALGORITHM in sidecar.read_text(encoding="utf-8")


def test_catalog_reuses_fresh_typed_audio_sidecar(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "known.wav"
    source.write_bytes(b"source bytes")
    audio_hash = "c" * 64
    sidecar = Path(f"{source}.audiohash")
    sidecar.write_text(
        f"{audio_hash}  {source.name}\n"
        f"{manager.AUDIO_HASH_ALGORITHM_MARKER} {manager.AUDIO_HASH_ALGORITHM}\n"
        f"{manager.SOURCE_FILE_SHA256_MARKER} "
        f"{hashlib.sha256(source.read_bytes()).hexdigest()}\n",
        encoding="utf-8",
    )
    os.utime(sidecar, (source.stat().st_mtime + 1, source.stat().st_mtime + 1))

    def unexpected_decode(_path: Path) -> None:
        raise AssertionError("typed sidecar should have been reused")

    monkeypatch.setattr(manager, "audio_content_sha256sum", unexpected_decode)

    record, error, _warning = manager.build_record_for_file(source)

    assert error is None
    assert record is not None
    assert record.hash == audio_hash


def test_catalog_recomputes_sidecar_when_source_changes_with_preserved_mtime(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "replaced.wav"
    source.write_bytes(b"original source")
    original_mtime = source.stat().st_mtime
    old_audio_hash = "c" * 64
    sidecar = Path(f"{source}.audiohash")
    sidecar.write_text(
        f"{old_audio_hash}  {source.name}\n"
        f"{manager.AUDIO_HASH_ALGORITHM_MARKER} {manager.AUDIO_HASH_ALGORITHM}\n"
        f"{manager.SOURCE_FILE_SHA256_MARKER} "
        f"{hashlib.sha256(source.read_bytes()).hexdigest()}\n",
        encoding="utf-8",
    )
    os.utime(sidecar, (original_mtime + 1, original_mtime + 1))

    source.write_bytes(b"replacement src")
    os.utime(source, (original_mtime, original_mtime))
    new_audio_hash = "d" * 64
    calls: list[Path] = []

    def compute_audio_hash(path: Path) -> str:
        calls.append(path)
        return new_audio_hash

    monkeypatch.setattr(manager, "audio_content_sha256sum", compute_audio_hash)

    record, error, _warning = manager.build_record_for_file(source)

    assert error is None
    assert record is not None
    assert record.hash == new_audio_hash
    assert calls == [source]
    assert hashlib.sha256(source.read_bytes()).hexdigest() in sidecar.read_text(encoding="utf-8")


def test_hash_command_rejects_decode_failure_by_default(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "broken.mp3"
    source.write_bytes(b"not audio")
    monkeypatch.setattr(hash_command, "audio_content_sha256sum", lambda _path: None)

    hash_value, error, warning = hash_command.compute_hash_for_file(source, use_sidecar=False)

    assert hash_value is None
    assert error is not None
    assert "audio decoding failed" in error
    assert warning is None


def test_explicit_catalog_contract_rejects_unknown_algorithm(tmp_path: Path) -> None:
    catalog = tmp_path / "catalog.csv"
    rows = [
        {
            "Hash": "d" * 64,
            "Hash Algorithm": "unknown-audio-identity-v1",
        }
    ]

    with pytest.raises(ValueError, match="unsupported algorithm"):
        manager.require_audio_hash_contract(
            ["Hash", "Hash Algorithm"],
            rows,
            path=catalog,
        )


def test_untyped_catalog_is_unsupported(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="missing required 'Hash Algorithm'"):
        manager.require_audio_hash_contract(
            ["Hash", "Filename"],
            [{"Hash": "e" * 64, "Filename": "untyped.wav"}],
            path=tmp_path / "untyped.csv",
        )


def _write_catalog(path: Path, fieldnames: list[str], row: dict[str, str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerow(row)


def test_add_rejects_untyped_catalog(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    catalog = tmp_path / "untyped.csv"
    _write_catalog(
        catalog,
        ["Hash", "Filename"],
        {"Hash": "e" * 64, "Filename": "untyped.wav"},
    )

    result = add_command.handle_add(argparse.Namespace(csv=catalog, encoding="utf-8"))

    assert result == 1
    error = capsys.readouterr().err
    assert "missing required 'Hash Algorithm'" in error
    assert "catalog create" in error


def test_merge_requires_both_catalogs_to_have_verified_contracts(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    typed = tmp_path / "typed.csv"
    untyped = tmp_path / "untyped.csv"
    _write_catalog(
        typed,
        ["Hash", "Hash Algorithm", "Filename"],
        {
            "Hash": "a" * 64,
            "Hash Algorithm": manager.AUDIO_HASH_ALGORITHM,
            "Filename": "typed.wav",
        },
    )
    _write_catalog(
        untyped,
        ["Hash", "Filename"],
        {"Hash": "b" * 64, "Filename": "untyped.wav"},
    )

    result = merge_command.handle_merge(
        argparse.Namespace(
            source1=typed,
            source2=untyped,
            output=tmp_path / "merged.csv",
            encoding="utf-8",
            hash_column=None,
            quiet=True,
        )
    )

    assert result == 1
    error = capsys.readouterr().err
    assert "missing required 'Hash Algorithm'" in error
    assert "catalog create" in error
    assert not (tmp_path / "merged.csv").exists()
