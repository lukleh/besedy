from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from besedy.workflows.align_nemo_with_whisperx import (
    PROJECT_ROOT,
    _build_canonical_conversion_invocation,
    main,
)


def test_build_canonical_conversion_invocation_uses_current_python(monkeypatch) -> None:
    monkeypatch.setenv("PYTHONPATH", "/tmp/existing")

    cmd, env = _build_canonical_conversion_invocation(
        aligned_output=Path("/tmp/aligned.json"),
        audio_path=Path("/tmp/audio.wav"),
        backend="canary-nemo-beam",
        model_label="nvidia/canary",
        canonical_output=Path("/tmp/transcript.json"),
        align_model_name="WAV2VEC2_ASR_LARGE_LV60K_960H",
    )

    assert cmd[:3] == [sys.executable, "-m", "besedy.cli.convert_whisperx_transcript"]
    assert "--align-model" in cmd
    assert env["PYTHONPATH"].split(os.pathsep)[0] == str(PROJECT_ROOT)


def test_build_canonical_conversion_invocation_avoids_duplicate_pythonpath(monkeypatch) -> None:
    monkeypatch.setenv("PYTHONPATH", f"{PROJECT_ROOT}{os.pathsep}/tmp/existing")

    _, env = _build_canonical_conversion_invocation(
        aligned_output=Path("/tmp/aligned.json"),
        audio_path=Path("/tmp/audio.wav"),
        backend="canary-nemo-beam",
        model_label="nvidia/canary",
        canonical_output=Path("/tmp/transcript.json"),
        align_model_name=None,
    )

    assert env["PYTHONPATH"].split(os.pathsep)[0] == str(PROJECT_ROOT)
    assert env["PYTHONPATH"].count(str(PROJECT_ROOT)) == 1


def test_main_fails_when_segments_audio_path_is_missing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    segments_path = tmp_path / "nemo_beam_segments.json"
    segments_path.write_text(
        json.dumps(
            {
                "language": "cs",
                "segments": [{"start": 0.0, "end": 1.0, "text": "ahoj"}],
                "meta": {"audio_filepath": str(tmp_path / "missing.wav")},
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)),
    )
    monkeypatch.setitem(
        sys.modules,
        "whisperx",
        SimpleNamespace(
            load_align_model=lambda *args, **kwargs: ("align-model", {"language": "cs"}),
            align=lambda *args, **kwargs: {"segments": [], "word_segments": []},
        ),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "align_nemo_with_whisperx.py",
            "--segments",
            str(segments_path),
            "--no-progress",
        ],
    )

    with pytest.raises(SystemExit, match="Alignment failed for:"):
        main()
