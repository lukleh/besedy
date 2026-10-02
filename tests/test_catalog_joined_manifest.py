"""Tests for joined catalog helpers and move planning."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from besedy.cli.catalog import build_parser
from besedy.commands.catalog import join as join_command
from besedy.commands.catalog.join import _plan_original_moves
from besedy.config.settings import get_config, set_config
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


@pytest.mark.parametrize(
    ("joined_audio_dir", "original_audio_dir"),
    [("/abs/joined", "originals"), ("joined_audio", "/abs/originals")],
)
def test_join_resolves_move_targets_before_writing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    joined_audio_dir: str,
    original_audio_dir: str,
) -> None:
    sources = [tmp_path / "a.mp3", tmp_path / "b.mp3"]
    for source in sources:
        source.write_bytes(b"")
    hash_calls: list[Path] = []
    monkeypatch.delenv("BESEDY_AUDIO_ARTIFACTS_ROOT", raising=False)
    monkeypatch.setattr(join_command, "probe_audio_file", lambda path, **_: _make_audio_info(path))
    monkeypatch.setattr(
        join_command,
        "audio_content_sha256sum",
        lambda path, **_: hash_calls.append(path) or "",
    )
    args = build_parser().parse_args(
        ["join", *map(str, sources), "-o", "out.mp3", "-d", str(tmp_path / "out")]
    )
    original = get_config()
    try:
        set_config(
            replace(
                original,
                paths=replace(
                    original.paths,
                    audio_artifacts_dir="",
                    joined_audio_dir=joined_audio_dir,
                    original_audio_dir=original_audio_dir,
                ),
            )
        )
        assert join_command.handle_join(args) == 1
    finally:
        set_config(original)

    assert "Error: Audio artifacts root is required." in capsys.readouterr().err
    assert hash_calls == []
    assert not (tmp_path / "out").exists()
