"""NeMo transcription utilities.

This package contains modules extracted from transcribe_nemo.py:
- segments: Segment splitting and text processing
- confidence: Confidence extraction and data classes
- vad: VAD pipeline (manifest, features, predictions)
- transcription: Model loading and transcription
"""

from __future__ import annotations

from besedy.lib.nemo.confidence import (
    SegmentResult,
    VadArtifacts,
    VadChunk,
    configure_asr_confidence,
    configure_asr_decoding_strategy,
)
from besedy.lib.nemo.segments import (
    CONTROL_TOKEN_PATTERN,
    ChunkingParams,
    ensure_max_segment_length,
    normalize_for_comparison,
    split_segments_like_faster_whisper,
    strip_control_tokens,
)
from besedy.lib.nemo.transcription import (
    load_asr,
    load_audio,
    load_frame_vad,
    resolve_device,
    transcribe_segments,
)
from besedy.lib.nemo.vad import (
    run_vad_segmentation,
)
from besedy.lib.nemo.vad_debug import (
    build_chunk_metadata,
    build_postprocessing_params,
    persist_vad_debug_artifacts,
)

__all__ = [
    # segments
    "ChunkingParams",
    "CONTROL_TOKEN_PATTERN",
    "split_segments_like_faster_whisper",
    "ensure_max_segment_length",
    "strip_control_tokens",
    "normalize_for_comparison",
    # confidence
    "SegmentResult",
    "VadChunk",
    "VadArtifacts",
    "configure_asr_confidence",
    "configure_asr_decoding_strategy",
    # vad
    "build_chunk_metadata",
    "persist_vad_debug_artifacts",
    "build_postprocessing_params",
    "run_vad_segmentation",
    # transcription
    "resolve_device",
    "load_audio",
    "load_frame_vad",
    "load_asr",
    "transcribe_segments",
]
