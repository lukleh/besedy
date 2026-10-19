"""The catalog CSVs the web sync reads must keep the columns in contracts/catalog-csv.json.

The web side is checked by web/tests/unit/catalog-csv-contract.test.ts against the
same file, so renaming a column on either side fails a test.
"""

from __future__ import annotations

import csv
import json
from argparse import Namespace
from pathlib import Path

import pytest

from besedy.commands.catalog import create as create_command
from besedy.commands.catalog.archive import ArchivedManifestWriter
from besedy.commands.catalog.file_processing import AddFilesResult
from besedy.commands.catalog.ui import write_duplicates_csv
from besedy.lib.catalog.manager import (
    AUDIO_HASH_ALGORITHM,
    FileRecord,
)

CONTRACT_PATH = Path(__file__).resolve().parents[1] / "contracts" / "catalog-csv.json"


@pytest.fixture(scope="module")
def contract() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def _record(tmp_path: Path, name: str, hash_value: str) -> FileRecord:
    return FileRecord(
        hash=hash_value,
        filename=name,
        full_path=tmp_path / name,
        hash_file=tmp_path / f"{name}.audiohash",
        exists=True,
        size_bytes=1000,
        size_human="1.0 KB",
        status="EXISTS",
        extension="mp3",
        scan_root=str(tmp_path),
    )


def _read(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def test_contract_hash_algorithm_is_the_one_python_writes(contract: dict) -> None:
    assert contract["hashAlgorithm"] == AUDIO_HASH_ALGORITHM


def test_metadata_catalog_writer_emits_the_contract_columns(
    contract: dict, tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "audio_catalog.csv"
    audio = tmp_path / "a.mp3"
    audio.touch()
    monkeypatch.setattr(
        create_command, "collect_input_files", lambda *args, **kwargs: ([audio], [])
    )
    monkeypatch.setattr(create_command, "check_ffprobe", lambda *args: True)
    monkeypatch.setattr(
        create_command,
        "add_files_to_catalog",
        lambda **kwargs: AddFilesResult(
            new_records=[_record(tmp_path, "a.mp3", "a" * 64)],
            duplicate_records=[],
            errors=[],
            sidecar_warnings=[],
        ),
    )
    result = create_command.handle_create(
        Namespace(
            directory=tmp_path,
            output=path,
            no_color=True,
            no_audio_filter=True,
            no_symlink=True,
            ffprobe_binary="ffprobe",
            ffprobe_timeout=30,
        )
    )
    assert result == 0

    header, rows = _read(path)

    assert set(contract["metadata"]) <= set(header)
    assert rows[0]["Hash Algorithm"] == contract["hashAlgorithm"]


def test_archived_manifest_writer_emits_the_contract_columns(
    contract: dict, tmp_path: Path
) -> None:
    path = tmp_path / "archived.csv"
    ArchivedManifestWriter(path)

    header, _ = _read(path)

    assert set(contract["archived"]) <= set(header)


def test_duplicates_writer_emits_the_contract_columns(contract: dict, tmp_path: Path) -> None:
    original = _record(tmp_path, "a.mp3", "a" * 64)
    duplicate = _record(tmp_path, "copy.mp3", "a" * 64)
    path = tmp_path / "duplicates.csv"

    write_duplicates_csv({"a" * 64: [duplicate]}, {"a" * 64: original}, path)

    header, rows = _read(path)

    assert set(contract["duplicates"]) <= set(header)
    assert rows[0]["Duplicate Path"] == str(duplicate.full_path)
