from __future__ import annotations

import warnings

import numpy as np
import pytest

pytestmark = pytest.mark.optional_dependency
pytest.importorskip("torch", reason="requires the optional ML extra")
sf = pytest.importorskip("soundfile", reason="requires the optional ML extra")

from besedy.lib.speakers.compat import (  # noqa: E402
    load_audio_with_soundfile,
    suppress_pyannote_torchcodec_warning,
)

_TORCHCODEC_WARNING = (
    "\ntorchcodec is not installed correctly so built-in audio decoding will fail. "
    "Solutions are:\n"
    "* use audio preloaded in-memory as a {'waveform': (channel, time) torch.Tensor, "
    "'sample_rate': int} dictionary;\n"
    "* fix torchcodec installation."
)


def _emit_warning(*, message: str, module: str) -> None:
    warnings.warn_explicit(
        message,
        UserWarning,
        filename=f"{module.replace('.', '/')}.py",
        lineno=47,
        module=module,
    )


def test_suppress_pyannote_torchcodec_warning_hides_expected_message() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        with suppress_pyannote_torchcodec_warning():
            _emit_warning(message=_TORCHCODEC_WARNING, module="pyannote.audio.core.io")

    assert caught == []


def test_suppress_pyannote_torchcodec_warning_keeps_other_messages() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        with suppress_pyannote_torchcodec_warning():
            _emit_warning(message="different warning", module="pyannote.audio.core.io")

    assert [str(item.message) for item in caught] == ["different warning"]


def test_load_audio_with_soundfile_returns_channel_first_waveform(tmp_path) -> None:
    audio_path = tmp_path / "stereo.wav"
    frames = np.array(
        [
            [0.10, -0.10],
            [0.25, -0.25],
            [0.50, -0.50],
        ],
        dtype=np.float32,
    )
    sf.write(audio_path, frames, 16_000)

    waveform, sample_rate = load_audio_with_soundfile(audio_path)

    assert sample_rate == 16_000
    assert tuple(waveform.shape) == (2, 3)
    np.testing.assert_allclose(waveform.numpy(), frames.T, atol=1e-4)
