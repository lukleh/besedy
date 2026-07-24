from __future__ import annotations

import pytest

from besedy.lib.backend_ids import (
    DIARIZATION_WORKFLOW_IDS,
    TRANSCRIPT_META_BACKENDS,
    TRANSCRIPTION_WORKFLOW_IDS,
    require_transcript_meta_backend,
    require_workflow_id,
    workflow_id_from_meta_backend,
)
from besedy.lib.workflow.config import (
    get_diarization_workflows,
    get_transcription_workflows,
)


def test_require_workflow_id_accepts_canonical_only():
    assert require_workflow_id("canary-nemo") == "canary-nemo"
    assert require_workflow_id("canary-nemo-beam") == "canary-nemo-beam"
    assert require_workflow_id("faster-whisper") == "faster-whisper"
    assert require_workflow_id("whisperx") == "whisperx"
    assert require_workflow_id("qwen3-asr") == "qwen3-asr"
    assert require_workflow_id("pyannote") == "pyannote"

    with pytest.raises(ValueError):
        require_workflow_id("nemo")

    with pytest.raises(ValueError):
        require_workflow_id("whisper_cpp")

    with pytest.raises(ValueError):
        require_workflow_id("speechbrain")


def test_transcript_meta_backend_mapping():
    assert require_transcript_meta_backend("canary-nemo") == "canary-nemo"
    assert require_transcript_meta_backend("canary-nemo-beam") == "canary-nemo-beam"
    assert require_transcript_meta_backend("whisperx") == "whisperx"
    assert require_transcript_meta_backend("faster-whisper") == "faster-whisper"
    assert require_transcript_meta_backend("qwen3-asr") == "qwen3-asr"

    assert workflow_id_from_meta_backend("canary-nemo") == "canary-nemo"
    assert workflow_id_from_meta_backend("canary-nemo-beam") == "canary-nemo-beam"
    assert workflow_id_from_meta_backend("whisperx") == "whisperx"
    assert workflow_id_from_meta_backend("faster-whisper") == "faster-whisper"
    assert workflow_id_from_meta_backend("qwen3-asr") == "qwen3-asr"

    with pytest.raises(ValueError):
        require_transcript_meta_backend("pyannote")


def test_constants_are_sane():
    assert "canary-nemo" in TRANSCRIPTION_WORKFLOW_IDS
    assert "canary-nemo-beam" in TRANSCRIPTION_WORKFLOW_IDS
    assert "whisperx" in TRANSCRIPTION_WORKFLOW_IDS
    assert "faster-whisper" in TRANSCRIPTION_WORKFLOW_IDS
    assert "qwen3-asr" in TRANSCRIPTION_WORKFLOW_IDS
    assert "pyannote" in DIARIZATION_WORKFLOW_IDS

    assert "canary-nemo" in TRANSCRIPT_META_BACKENDS
    assert "canary-nemo-beam" in TRANSCRIPT_META_BACKENDS
    assert "faster-whisper" in TRANSCRIPT_META_BACKENDS
    assert "whisperx" in TRANSCRIPT_META_BACKENDS
    assert "qwen3-asr" in TRANSCRIPT_META_BACKENDS


def test_workflow_configs_and_backend_ids_stay_in_sync():
    configured_transcription = {c.workflow_id for c in get_transcription_workflows()}
    assert configured_transcription.issubset(set(TRANSCRIPTION_WORKFLOW_IDS))
    assert {c.workflow_id for c in get_diarization_workflows()} == set(DIARIZATION_WORKFLOW_IDS)
