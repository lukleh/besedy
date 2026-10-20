"""`catalog create --output` must not need the configured text data root."""

from __future__ import annotations

from argparse import Namespace
from pathlib import Path

import pytest

from besedy.commands.catalog import create as create_command
from besedy.commands.catalog.file_processing import AddFilesResult


def _unconfigured_root() -> Path:
    raise RuntimeError("Text data root is required.")


def test_explicit_output_skips_catalogs_root_resolution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = tmp_path / "a.mp3"
    audio.touch()
    monkeypatch.setattr(create_command, "resolve_catalogs_root", _unconfigured_root)
    monkeypatch.setattr(
        create_command, "collect_input_files", lambda *args, **kwargs: ([audio], [])
    )
    monkeypatch.setattr(create_command, "check_ffprobe", lambda *args: True)
    monkeypatch.setattr(
        create_command,
        "add_files_to_catalog",
        lambda **kwargs: AddFilesResult(
            new_records=[], duplicate_records=[], errors=[], sidecar_warnings=[]
        ),
    )
    output = tmp_path / "out" / "catalog.csv"
    output.parent.mkdir()

    result = create_command.handle_create(
        Namespace(
            directory=tmp_path,
            output=output,
            no_color=True,
            no_audio_filter=True,
            no_symlink=True,
            ffprobe_binary="ffprobe",
            ffprobe_timeout=30,
        )
    )

    assert result == 0
    assert output.exists()
