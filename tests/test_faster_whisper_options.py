"""The production decode options are defined once and shared with the evaluation."""

from __future__ import annotations

from besedy.config.settings import VadConfig
from besedy.lib.workflow.faster_whisper_options import production_transcribe_options


def test_options_follow_the_vad_configuration() -> None:
    vad = VadConfig(filter_enabled=True, word_timestamps=True, min_silence_ms=None)
    assert production_transcribe_options(language="cs", batch_size=8, vad=vad) == {
        "batch_size": 8,
        "vad_filter": True,
        "vad_parameters": None,
        "word_timestamps": True,
        "language": "cs",
        "log_progress": True,
        "condition_on_previous_text": False,
        "repetition_penalty": 1.1,
    }
    with_silence = VadConfig(filter_enabled=False, word_timestamps=False, min_silence_ms=500)
    options = production_transcribe_options(language=None, batch_size=2, vad=with_silence)
    assert options["vad_parameters"] == {"min_silence_duration_ms": 500}
    assert options["vad_filter"] is False and options["word_timestamps"] is False
    assert options["language"] is None
