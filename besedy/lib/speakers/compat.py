"""Compatibility helpers for pyannote-based speaker workflows.

Besedy preloads audio into memory with soundfile for diarization and speaker
embedding extraction, so pyannote's built-in torchcodec decoder is not used in
these paths. Newer pyannote releases still probe torchcodec at import time and
emit a very noisy warning when the bundled binary is not usable in our runtime.
"""

from __future__ import annotations

import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import soundfile as sf
import torch

_PYANNOTE_TORCHCODEC_WARNING = (
    r"\s*torchcodec is not installed correctly so built-in audio decoding will fail\..*"
)


@contextmanager
def suppress_pyannote_torchcodec_warning() -> Iterator[None]:
    """Suppress pyannote's import-time torchcodec warning for in-memory audio paths."""

    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=_PYANNOTE_TORCHCODEC_WARNING,
            category=UserWarning,
            module=r"pyannote\.audio\.core\.io",
        )
        yield


def load_audio_with_soundfile(path: Path) -> tuple[torch.Tensor, int]:
    """Load audio as a channel-first float32 waveform tensor."""

    audio_data, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    waveform = torch.from_numpy(audio_data.T.copy())
    return waveform, int(sample_rate)
