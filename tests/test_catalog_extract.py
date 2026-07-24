"""Tests for transcript sidecar export behavior."""

from __future__ import annotations

import io
import json
from pathlib import Path

from rich.console import Console

from besedy.commands.catalog.extract import _export_transcripts_with_progress


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _run_export(path: Path, *, overwrite: bool = False) -> dict:
    transcript_map = {("faster-whisper", "model", "hash"): path}
    console = Console(file=io.StringIO(), force_terminal=False, color_system=None)
    return _export_transcripts_with_progress(transcript_map, console, overwrite=overwrite)


def test_export_transcripts_txt_is_newline_delimited_by_segment(tmp_path: Path) -> None:
    transcript_path = tmp_path / "faster-whisper" / "model" / "hash" / "transcript.json"
    _write_json(
        transcript_path,
        {
            "segments": [
                {"start": 0.0, "end": 1.0, "text": " First segment "},
                {"start": 1.0, "end": 2.0, "text": "Second segment"},
            ]
        },
    )

    stats = _run_export(transcript_path)

    assert stats["processed"] == 1
    txt_path = transcript_path.parent / "transcript.txt"
    assert txt_path.read_text(encoding="utf-8") == "First segment\nSecond segment\n"


def test_export_transcripts_txt_falls_back_when_no_valid_segments(tmp_path: Path) -> None:
    transcript_path = tmp_path / "faster-whisper" / "model" / "hash" / "transcript.json"
    _write_json(
        transcript_path,
        {
            "meta": {"transcript_text": "Fallback transcript text"},
            "segments": [
                {"start": "not-a-number", "end": 1.0, "text": "ignored"},
            ],
        },
    )

    stats = _run_export(transcript_path)

    assert stats["processed"] == 1
    txt_path = transcript_path.parent / "transcript.txt"
    assert txt_path.read_text(encoding="utf-8") == "Fallback transcript text\n"


def test_export_transcripts_overwrite_forces_regeneration(tmp_path: Path) -> None:
    transcript_path = tmp_path / "faster-whisper" / "model" / "hash" / "transcript.json"
    _write_json(
        transcript_path,
        {
            "segments": [
                {"start": 0.0, "end": 1.0, "text": "First segment"},
                {"start": 1.0, "end": 2.0, "text": "Second segment"},
            ]
        },
    )

    first = _run_export(transcript_path)
    assert first["processed"] == 1
    assert first["skipped"] == 0

    txt_path = transcript_path.parent / "transcript.txt"
    txt_path.write_text("custom sidecar content\n", encoding="utf-8")

    skipped = _run_export(transcript_path)
    assert skipped["processed"] == 0
    assert skipped["skipped"] == 1
    assert txt_path.read_text(encoding="utf-8") == "custom sidecar content\n"

    overwritten = _run_export(transcript_path, overwrite=True)
    assert overwritten["processed"] == 1
    assert overwritten["skipped"] == 0
    assert txt_path.read_text(encoding="utf-8") == "First segment\nSecond segment\n"
