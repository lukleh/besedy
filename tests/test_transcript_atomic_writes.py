"""Slice G: transcript writers publish their JSON atomically."""

from __future__ import annotations

import ast
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from besedy.cli import convert_stable_ts, convert_whisperx_transcript

# The workflow runners import their ML backend at module scope. Stub
# faster-whisper only when the optional extra is absent, so the lean suite can
# still drive main() while an ML-extra environment keeps the real package.
if importlib.util.find_spec("faster_whisper") is None:  # pragma: no cover - env dependent
    sys.modules.setdefault("faster_whisper", MagicMock())
    sys.modules.setdefault("faster_whisper.vad", MagicMock())

from besedy.workflows import transcribe_faster_whisper as faster_whisper_module  # noqa: E402


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


# ---------------------------------------------------------------------------
# Workflow writers
# ---------------------------------------------------------------------------

WORKFLOWS_DIR = Path(faster_whisper_module.__file__).parent

# Every transcription backend that publishes a transcript.json bundle.
TRANSCRIPTION_WORKFLOWS = [
    "transcribe_faster_whisper.py",
    "transcribe_nemo.py",
    "transcribe_qwen3_asr.py",
    "transcribe_whisperx.py",
]


def _drive_faster_whisper_main(monkeypatch, tmp_path: Path, bundle_root: Path) -> Path:
    """Run transcribe_faster_whisper.main() with the ML backend stubbed out.

    Returns the transcript.json path the run published.
    """
    audio_hash = "b" * 64
    audio_path = tmp_path / f"{audio_hash}.wav"
    audio_path.touch()

    class DummyPipeline:
        def transcribe(self, _audio_path: str, **_kwargs: object):
            info = SimpleNamespace(language="cs", transcription_options=None)
            return iter(()), info

    default_config = SimpleNamespace(
        model_name="large-v3",
        vad_model="silero_vad_v6",
        language="cs",
    )
    monkeypatch.setattr(
        faster_whisper_module,
        "select_transcription_workflow",
        lambda *_args, **_kwargs: default_config,
    )
    monkeypatch.setattr(
        faster_whisper_module, "resolve_bundle_root", lambda *_args, **_kwargs: bundle_root
    )
    monkeypatch.setattr(faster_whisper_module, "resolve_model_reference", lambda model: model)
    monkeypatch.setattr(faster_whisper_module, "WhisperModel", lambda *_a, **_k: object())
    monkeypatch.setattr(
        faster_whisper_module, "BatchedInferencePipeline", lambda *, model: DummyPipeline()
    )
    monkeypatch.setattr(faster_whisper_module, "extract_vad_segments", lambda *_a, **_k: [])
    monkeypatch.setattr(
        faster_whisper_module,
        "build_payload",
        lambda *_a, **_k: {"meta": {"backend": "faster-whisper"}, "segments": []},
    )
    monkeypatch.setattr(sys, "argv", ["prog", "--audio", str(audio_path), "--device", "cpu"])

    assert faster_whisper_module.main() == 0
    return bundle_root / audio_hash / "transcript.json"


def test_faster_whisper_workflow_writes_transcript_atomically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle_root = tmp_path / "bundle"
    out = _drive_faster_whisper_main(monkeypatch, tmp_path, bundle_root)

    result = json.loads(out.read_text(encoding="utf-8"))
    assert "meta" in result and "segments" in result
    # Atomic publication leaves no .besedy-tmp-* residue beside the output.
    assert [p.name for p in out.parent.iterdir()] == ["transcript.json"]


def test_faster_whisper_workflow_overwrite_leaves_no_residue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle_root = tmp_path / "bundle"
    stale = bundle_root / ("b" * 64) / "transcript.json"
    stale.parent.mkdir(parents=True)
    stale.write_text("STALE", encoding="utf-8")

    out = _drive_faster_whisper_main(monkeypatch, tmp_path, bundle_root)

    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["meta"]["backend"] == "faster-whisper"
    assert [p.name for p in out.parent.iterdir()] == ["transcript.json"]


def _publishing_calls(tree: ast.AST) -> list[str]:
    """Return non-atomic file-publication calls found in a parsed module.

    The workflow runners must route every output through atomic_io, so a bare
    Path.write_text/write_bytes, a json.dump into an open handle, or a
    write-mode open() at the final path is a regression.
    """
    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute):
            if func.attr in {"write_text", "write_bytes"}:
                offenders.append(f"line {node.lineno}: .{func.attr}()")
            elif func.attr == "dump" and isinstance(func.value, ast.Name):
                if func.value.id == "json":
                    offenders.append(f"line {node.lineno}: json.dump()")
            elif func.attr == "open":
                mode = node.args[0] if node.args else None
                if isinstance(mode, ast.Constant) and "r" not in str(mode.value):
                    offenders.append(f"line {node.lineno}: .open({mode.value!r})")
    return offenders


@pytest.mark.parametrize("module_name", TRANSCRIPTION_WORKFLOWS)
def test_workflow_publishes_only_through_atomic_io(module_name: str) -> None:
    """Guard against a backend regressing to a non-atomic write."""
    source = (WORKFLOWS_DIR / module_name).read_text(encoding="utf-8")
    tree = ast.parse(source)

    offenders = _publishing_calls(tree)
    assert not offenders, f"{module_name} publishes without atomic_io: {offenders}"

    imports_atomic = any(
        isinstance(node, ast.ImportFrom)
        and node.module == "besedy.lib.data.atomic_io"
        and any(alias.name.startswith("atomic_") for alias in node.names)
        for node in ast.walk(tree)
    )
    assert imports_atomic, f"{module_name} does not import an atomic_io writer"
