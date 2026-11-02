"""The decode options the production faster-whisper backend uses.

``besedy/workflows/transcribe_faster_whisper.py`` transcribes with these and
``besedy/workflows/eval_faster_whisper.py`` scores models with the same ones,
so an evaluation measures the model the way production will run it. Change
them here only.
"""

from __future__ import annotations

from typing import Any

from besedy.config.settings import VadConfig, config


def production_transcribe_options(
    *,
    language: str | None,
    batch_size: int,
    vad: VadConfig | None = None,
) -> dict[str, Any]:
    """Keyword arguments for ``BatchedInferencePipeline.transcribe``.

    ``language`` is the inference language (None lets the model detect it).
    The batched pipeline runs its own Silero VAD pass while decoding and packs
    the regions into inputs of at most 30 s of speech; ``vad_parameters`` is
    only set when the configuration names a minimum silence.
    """
    vad = vad if vad is not None else config.vad
    options: dict[str, Any] = {
        "batch_size": batch_size,
        "vad_filter": vad.filter_enabled,
        "vad_parameters": (
            dict(min_silence_duration_ms=vad.min_silence_ms)
            if vad.min_silence_ms is not None
            else None
        ),
        "word_timestamps": vad.word_timestamps,
        "language": language,
        "log_progress": True,
        # Equivalent to --max-context 0: every chunk is decoded on its own.
        "condition_on_previous_text": False,
        "repetition_penalty": 1.1,
    }
    return options
