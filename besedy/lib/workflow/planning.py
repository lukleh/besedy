"""Plan the missing stages for each recording before applying workflow limits."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from besedy.core.paths import hash_component_from_sha
from besedy.lib.workflow.common import CsvAudioRow
from besedy.lib.workflow.config import WorkflowConfig


@dataclass(frozen=True)
class RecordingTranscriptionPlan:
    audio_hash: str
    transcribe: bool
    align: bool


def plan_transcription(
    rows: Sequence[CsvAudioRow],
    config: WorkflowConfig,
    workflow_dir: Path,
    *,
    overwrite: bool,
) -> list[RecordingTranscriptionPlan]:
    """Return one plan per incomplete recording, in catalog order.

    Beam decoding and alignment are stages of the same recording. A caller
    limits this list once, keeping all required stages for each selected row.
    """
    beam = (
        config.workflow_id in {"canary-nemo", "canary-nemo-beam"}
        and config.decode_strategy == "beam"
    )
    plans: list[RecordingTranscriptionPlan] = []
    for row in rows:
        audio_hash = hash_component_from_sha(row.sha256)
        directory = workflow_dir / audio_hash
        transcript_missing = overwrite or not (directory / config.output_filename).exists()
        transcribe = (
            overwrite or not (directory / "nemo_beam_segments.json").exists()
            if beam
            else transcript_missing
        )
        align = beam and transcript_missing
        if transcribe or align:
            plans.append(RecordingTranscriptionPlan(audio_hash, transcribe, align))
    return plans
