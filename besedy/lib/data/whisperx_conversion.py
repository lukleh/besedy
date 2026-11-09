"""Convert WhisperX payloads into the canonical Besedy transcript schema."""

from __future__ import annotations

from typing import Any

from besedy.lib.data.transcript_conversion import TranscriptConversionError, convert_transcript


class WhisperXConversionError(TranscriptConversionError):
    """Raised when WhisperX data cannot be converted reliably."""


def convert_whisperx(
    payload: dict,
    *,
    backend: str,
    model: str,
    duration_seconds: float,
    audio_filepath: str | None,
    align_model: str | None = None,
    vad_method: str | None = None,
    compute_type: str | None = None,
    batch_size: int | None = None,
) -> dict:
    """Convert one WhisperX response into a canonical transcript payload."""

    if not isinstance(payload, dict):
        raise WhisperXConversionError("transcript must be an object")

    generation_params: dict[str, Any] = {"language": payload.get("language")}
    if align_model:
        generation_params["align_model"] = align_model
    if vad_method:
        generation_params["vad_method"] = vad_method
    if compute_type:
        generation_params["compute_type"] = compute_type
    if batch_size is not None:
        generation_params["batch_size"] = batch_size

    return convert_transcript(
        payload,
        backend=backend,
        model=model,
        duration_seconds=duration_seconds,
        audio_filepath=audio_filepath,
        generation_params=generation_params,
        confidence_field="score",
        error_type=WhisperXConversionError,
    )


__all__ = ["WhisperXConversionError", "convert_whisperx"]
