"""Tests for joined catalog helpers and move planning."""

from __future__ import annotations

from pathlib import Path

import pytest

from besedy.commands.catalog.join import _plan_original_moves
from besedy.lib.audio.join import AudioFileInfo
from besedy.lib.catalog.joined_manifest import find_duplicate_join, group_joined_rows


def _make_audio_info(path: Path) -> AudioFileInfo:
    return AudioFileInfo(
        path=path,
        codec="mp3",
        sample_rate=44100,
        channels=2,
        bitrate_kbps=192,
        duration_seconds=1.0,
        is_lossless=False,
    )


def test_find_duplicate_join_matches_signature():
    rows = [
        {
            "Source Order": "1",
            "Source Hash": "hash1",
            "Source Path": "/src/a.mp3",
            "Output Hash": "out-hash",
            "Output Path": "/out/combined.mp3",
            "Output Filename": "combined.mp3",
        },
        {
            "Source Order": "2",
            "Source Hash": "hash2",
            "Source Path": "/src/b.mp3",
            "Output Hash": "out-hash",
            "Output Path": "/out/combined.mp3",
            "Output Filename": "combined.mp3",
        },
    ]
    groups = group_joined_rows(rows)
    duplicate = find_duplicate_join(groups, ["hash1", "hash2"])
    assert duplicate is not None
    assert duplicate.output_path == "/out/combined.mp3"


def test_plan_original_moves_rejects_duplicate_destinations(tmp_path):
    dir_one = tmp_path / "one"
    dir_two = tmp_path / "two"
    dir_one.mkdir()
    dir_two.mkdir()

    file_one = dir_one / "dup.wav"
    file_two = dir_two / "dup.wav"
    file_one.write_text("a")
    file_two.write_text("b")

    files = [_make_audio_info(file_one), _make_audio_info(file_two)]
    backup_root = tmp_path / "backup"

    with pytest.raises(RuntimeError, match="Multiple source files map to the same backup path"):
        _plan_original_moves(files, backup_root=backup_root, scan_roots=[])
