"""Slice G: transcript writers publish their JSON atomically."""

from __future__ import annotations

import json
from pathlib import Path

from besedy.cli import convert_stable_ts, convert_whisperx_transcript


def _run(module, monkeypatch, argv: list[str]) -> None:
    monkeypatch.setattr("sys.argv", argv)
    module.main()


def test_convert_whisperx_writes_transcript_atomically(tmp_path: Path, monkeypatch) -> None:
    raw = tmp_path / "raw.json"
    raw.write_text(json.dumps({"language": "cs", "segments": []}), encoding="utf-8")
    out = tmp_path / "out" / "transcript.json"

    _run(
        convert_whisperx_transcript,
        monkeypatch,
        ["convert", str(raw), "--duration", "12.5", "--output", str(out)],
    )

    # Output created (parent dir made by atomic_path) and valid.
    result = json.loads(out.read_text(encoding="utf-8"))
    assert "meta" in result and "segments" in result
    # Atomic publication leaves no .besedy-tmp-* residue beside the output.
    assert [p.name for p in out.parent.iterdir()] == ["transcript.json"]


def test_convert_whisperx_overwrite_preserves_prior_on_success(tmp_path: Path, monkeypatch) -> None:
    raw = tmp_path / "raw.json"
    raw.write_text(json.dumps({"language": "cs", "segments": []}), encoding="utf-8")
    out = tmp_path / "transcript.json"
    out.write_text("STALE", encoding="utf-8")

    _run(
        convert_whisperx_transcript,
        monkeypatch,
        ["convert", str(raw), "--duration", "5", "--output", str(out)],
    )

    result = json.loads(out.read_text(encoding="utf-8"))
    assert result.get("meta", {}).get("duration") == 5
    assert sorted(p.name for p in tmp_path.iterdir()) == ["raw.json", "transcript.json"]


def test_convert_stable_ts_writes_transcript_atomically(tmp_path: Path, monkeypatch) -> None:
    raw = tmp_path / "raw.json"
    raw.write_text(json.dumps({"language": "cs", "segments": []}), encoding="utf-8")
    out = tmp_path / "out" / "transcript.json"

    # Pass --model so main() doesn't fall back to a besedy.toml workflow lookup.
    _run(
        convert_stable_ts,
        monkeypatch,
        ["convert", str(raw), "--duration", "8", "--model", "test-model", "--output", str(out)],
    )

    result = json.loads(out.read_text(encoding="utf-8"))
    assert "meta" in result and "segments" in result
    assert [p.name for p in out.parent.iterdir()] == ["transcript.json"]
