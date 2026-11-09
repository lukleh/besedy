"""Exercise current VAD metadata through transcription without loading GPU models."""

from __future__ import annotations

import ast
import logging
import math
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

NEMO_SOURCE = Path(__file__).resolve().parents[1] / "besedy" / "lib" / "nemo"


def _load_functions(filename, names, namespace):
    """Load actual functions while supplying doubles for model/runtime imports."""
    path = NEMO_SOURCE / filename
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in functions} == set(names)
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    module = ast.fix_missing_locations(ast.Module(body=[future, *functions], type_ignores=[]))
    exec(compile(module, str(path), "exec"), namespace)


class _Waveform:
    def __init__(self, samples):
        self.samples = samples
        self.shape = samples.shape

    def __getitem__(self, index):
        return _Waveform(self.samples[index])

    def numel(self):
        return self.samples.size

    def cpu(self):
        return self

    def numpy(self):
        return self.samples


@pytest.mark.parametrize("asr_confidence, expected", [(None, 0.8), (0.95, 0.95)])
def test_transcription_uses_current_vad_probability(tmp_path, asr_confidence, expected):
    namespace = {
        "np": np,
        "logging": logging,
        "math": math,
        "os": os,
        "tempfile": tempfile,
        "SegmentResult": SimpleNamespace,
        "MultiTaskTranscriptionConfig": SimpleNamespace,
        "sf": SimpleNamespace(write=lambda *_: None),
        "tqdm": lambda items, **_: items,
        "strip_control_tokens": lambda text: text,
        "_normalize_nested": lambda value: value,
        "_derive_segment_confidence": lambda hypothesis: hypothesis.confidence,
    }
    _load_functions("vad_inference.py", ["_parse_rttm_segments"], namespace)
    _load_functions("confidence.py", ["_coerce_float"], namespace)
    _load_functions("transcription.py", ["transcribe_segments"], namespace)

    (tmp_path / "clip.rttm").write_text("SPEAKER clip 1 0.0 0.1 <NA> <NA> speaker <NA> <NA>\n")
    segments = namespace["_parse_rttm_segments"](
        tmp_path, {"clip": np.full(5, 0.8)}, 0.02,
    )["clip"]
    assert segments == [{"start": 0.0, "end": 0.1, "mean_prob": 0.8}]
    # An obsolete field must not override the value emitted by the producer.
    segments[0]["mean_probability"] = 0.1
    hypothesis = SimpleNamespace(text="Ahoj", confidence=asr_confidence)

    def transcribe(*, audio, **_):
        assert Path(audio[0]).is_file()
        return [hypothesis]

    model = SimpleNamespace(eval=lambda: None, transcribe=transcribe)
    result, = namespace["transcribe_segments"](
        waveform=_Waveform(np.zeros(1600)),
        asr_model=model,
        artifacts=SimpleNamespace(segments=segments, chunks=[]),
        frame_unit=0.02,
        batch_size=1,
        sample_rate=16000,
        source_lang="cs",
        target_lang="cs",
    )
    assert result.text == "Ahoj"
    assert result.mean_probability == expected
