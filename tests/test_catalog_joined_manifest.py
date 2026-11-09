"""Tests for joined catalog helpers and move planning."""

from __future__ import annotations

import csv
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from besedy.cli.catalog import build_parser
from besedy.commands.catalog import join as join_command
from besedy.commands.catalog.join import _plan_original_moves
from besedy.config.settings import get_config, set_config
from besedy.lib.audio.join import AudioFileInfo, JoinMetadata, JoinStrategy
from besedy.lib.catalog.joined_manifest import (
    JOINED_CSV_COLUMNS,
    find_duplicate_join,
    group_joined_rows,
    load_joined_manifest,
)


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
            **dict.fromkeys(JOINED_CSV_COLUMNS, ""),
            "Source Count": "2",
            "Source Order": "1",
            "Source Hash": "1" * 64,
            "Source Path": "/src/a.mp3",
            "Output Hash": "a" * 64,
            "Output Path": "/out/combined.mp3",
            "Output Filename": "combined.mp3",
        },
        {
            **dict.fromkeys(JOINED_CSV_COLUMNS, ""),
            "Source Count": "2",
            "Source Order": "2",
            "Source Hash": "2" * 64,
            "Source Path": "/src/b.mp3",
            "Output Hash": "a" * 64,
            "Output Path": "/out/combined.mp3",
            "Output Filename": "combined.mp3",
        },
    ]
    groups = group_joined_rows(rows)
    duplicate = find_duplicate_join(groups, ["1" * 64, "2" * 64])
    assert duplicate is not None
    assert duplicate.output_path == "/out/combined.mp3"


def _write_joined_rows(path, rows, columns=JOINED_CSV_COLUMNS):
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def _current_joined_row(**updates):
    return {
        **dict.fromkeys(JOINED_CSV_COLUMNS, ""),
        "Source Hash": "1" * 64,
        "Output Hash": "a" * 64,
        "Source Order": "1",
        "Source Count": "2",
        **updates,
    }


@pytest.mark.parametrize("columns", [[], ["Output Hash"], list(reversed(JOINED_CSV_COLUMNS))])
def test_rejects_incompatible_joined_headers_without_appending(tmp_path, columns):
    manifest = tmp_path / "joined.csv"
    _write_joined_rows(manifest, [], columns)
    original = manifest.read_bytes()
    with pytest.raises(ValueError, match="current joined manifest header"):
        load_joined_manifest(manifest)
    with pytest.raises(ValueError, match="current joined manifest header"):
        with join_command.JoinedManifestWriter(manifest):
            pytest.fail("incompatible manifest was opened for append")
    assert manifest.read_bytes() == original


@pytest.mark.parametrize("updates", [
    {"Output Hash": ""}, {"Output Hash": "a" * 16}, {"Source Hash": "B" * 64},
    {"Source Order": ""}, {"Source Order": "0"}, {"Source Order": "first"},
    {"Source Order": "3"}, {"Source Count": ""},
])
def test_rejects_joined_identity_and_order_fallbacks(tmp_path, updates):
    manifest = tmp_path / "joined.csv"
    row = _current_joined_row(**updates, **{"Output Path": "/out/joined.mp3"})
    _write_joined_rows(manifest, [row])
    with pytest.raises(ValueError):
        load_joined_manifest(manifest)
    with pytest.raises(ValueError):
        group_joined_rows([row])


def test_current_writer_roundtrip_and_append_preserve_optional_blanks(tmp_path):
    manifest = tmp_path / "joined.csv"
    strategy = JoinStrategy("reencode", "mp3", 44100, 2, 192, False)
    metadata = JoinMetadata(None, None, None, None, None, "")
    for order in (2, 1):
        with join_command.JoinedManifestWriter(manifest) as writer:
            writer.write_entry(
                source_order=order,
                source=replace(_make_audio_info(tmp_path / f"{order}.mp3"), bitrate_kbps=None),
                source_hash=str(order) * 64,
                output_path=tmp_path / "combined.mp3",
                output_hash="a" * 64,
                output_duration_seconds=2.0,
                strategy=strategy,
                metadata=metadata,
                source_count=2,
            )
    columns, rows = load_joined_manifest(manifest)
    assert columns == JOINED_CSV_COLUMNS
    assert len(rows) == 2
    assert rows[0]["Source Title"] == rows[0]["Source Bitrate (kbps)"] == ""
    group, = group_joined_rows(rows)
    assert group.source_hashes == ("1" * 64, "2" * 64)
    assert group.output_path == str(tmp_path / "combined.mp3")


@pytest.mark.parametrize("incompatible_manifest", [False, True])
def test_join_failure_preserves_originals_and_manifest(
    tmp_path, monkeypatch, capsys, incompatible_manifest,
):
    sources = [tmp_path / "a.mp3", tmp_path / "b.mp3"]
    for source in sources:
        source.write_bytes(b"original")
    output = tmp_path / "out" / "combined.mp3"
    manifest = tmp_path / "audio_catalog_20261109_010000_joined.csv"
    if incompatible_manifest:
        manifest.write_text("Output Path\nold.mp3\n")
    monkeypatch.setattr(join_command, "probe_audio_file", lambda path, **_: _make_audio_info(path))
    monkeypatch.setattr(join_command, "resolve_original_audio_root", lambda: tmp_path / "originals")
    monkeypatch.setattr(join_command, "resolve_joined_audio_root", lambda: tmp_path / "out")
    monkeypatch.setattr(join_command, "resolve_catalogs_root", lambda: tmp_path)
    monkeypatch.setattr(join_command, "_get_catalog_timestamp", lambda: "20261109_010000")
    monkeypatch.setattr(join_command, "_check_duplicate_join_in_catalog", lambda *_: (False, None))
    monkeypatch.setattr(join_command, "build_reencode_command", lambda *_, **__: ["fake-ffmpeg"])
    monkeypatch.setattr(
        join_command, "audio_content_sha256sum",
        lambda path, **_: str(sources.index(path) + 1) * 64 if path in sources else "",
    )

    def join_audio(*_, **__):
        assert not incompatible_manifest, "incompatible append must fail before joining audio"
        output.write_bytes(b"joined")
        return subprocess.CompletedProcess(["fake-ffmpeg"], 0, b"", b"")

    monkeypatch.setattr(join_command.subprocess, "run", join_audio)
    args = build_parser().parse_args([
        "join", *map(str, sources), "-o", output.name, "-d", str(output.parent),
    ])
    assert join_command.handle_join(args) == 1
    expected = "Cannot append to joined catalog" if incompatible_manifest else "Could not compute output hash"
    assert expected in capsys.readouterr().err
    assert all(source.read_bytes() == b"original" for source in sources)
    if incompatible_manifest:
        assert manifest.read_text() == "Output Path\nold.mp3\n"
        assert not output.exists()
    else:
        assert not manifest.exists()
    assert not (tmp_path / "originals").exists()


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
