"""Embedding extraction for speaker clustering.

This module provides functions for:
- Loading embedding models (pyannote)
- Extracting per-segment embeddings from audio
- Pooling embeddings per speaker using duration-weighted averaging

NOTE: This module requires pyannote-audio in the current runtime. Besedy
normally runs cluster_speakers.py inside the Docker pyannote worker.
"""

from __future__ import annotations

import os
import traceback
from collections import defaultdict
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import torch

from besedy.core.paths import resolve_project_path
from besedy.lib.speakers.cache import EmbeddingCache
from besedy.lib.speakers.compat import (
    load_audio_with_soundfile,
    suppress_pyannote_torchcodec_warning,
)
from besedy.lib.speakers.utils import (
    compute_segments_checksum,
    load_diarization_json,
    segment_key,
)

# Lazy imports for pyannote
# Import only for type checking, actual imports happen at runtime in functions
if TYPE_CHECKING:
    pass

# Runtime imports are deferred to function calls
_pyannote_available: bool | None = None


def _check_pyannote() -> bool:
    """Check if pyannote-audio is available."""
    global _pyannote_available
    if _pyannote_available is None:
        try:
            with suppress_pyannote_torchcodec_warning():
                import pyannote.audio  # noqa: F401
                import pyannote.core  # noqa: F401

            _pyannote_available = True
        except ImportError:
            _pyannote_available = False
    return _pyannote_available


def _require_pyannote() -> None:
    """Raise helpful error if pyannote is not available."""
    if not _check_pyannote():
        raise ImportError(
            "pyannote-audio is not installed in this environment. "
            "Use the Besedy Docker pyannote worker, or install pyannote-audio in the "
            "current Python environment for direct host execution."
        )


# Type aliases
SpeakerId = tuple[str, str]  # (audio_file_identifier, speaker_label)
EmbeddingMap = dict[SpeakerId, np.ndarray]


def load_embedding_model(
    hf_token: str | None,
    device: torch.device,
    model_name: str = "pyannote",
) -> tuple[Any, str]:
    """Load embedding model (pyannote).

    NOTE: This function requires pyannote-audio in the current runtime.

    Args:
        hf_token: HuggingFace token for pyannote model access.
        device: torch device to load model onto.
        model_name: Embedding model to use. Currently only "pyannote" is supported.

    Returns:
        Tuple of (inference_object, model_name_str).

    Raises:
        ImportError: If pyannote-audio is not installed.
        ValueError: If an unsupported model name is provided.
    """
    print("=" * 60)
    print("Loading embedding model...")
    print("=" * 60)

    if model_name != "pyannote":
        raise ValueError(
            f"Unsupported embedding model: {model_name}. Only 'pyannote' is supported."
        )

    # pyannote checkpoints still rely on pickle-backed torch.load behavior.
    # Keep this scoped to the embedding worker process and preserve explicit user overrides.
    os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")

    _require_pyannote()
    with suppress_pyannote_torchcodec_warning():
        from pyannote.audio import Inference, Model

    print("\nLoading pyannote embedding model...")
    embedding_model = Model.from_pretrained("pyannote/embedding", token=hf_token)
    embedding_inference = Inference(embedding_model, device=device, window="whole")
    print("   ✓ Pyannote embedding model loaded")
    return embedding_inference, "pyannote-embedding"


def pool_embeddings(
    inference: Any,  # pyannote Inference - but lazy loaded
    diarization_data: dict,
    json_path: Path,
    min_duration: float = 1.0,
    cache: EmbeddingCache | None = None,
) -> dict[str, np.ndarray]:
    """Generate pooled speaker embeddings from diarization JSON.

    Extracts embeddings for each segment and pools them per speaker
    using duration-weighted averaging of L2-normalized vectors.

    Short segments below min_duration seconds are skipped to reduce noise.

    NOTE: This function requires pyannote-audio in the current runtime.

    Args:
        inference: Pyannote Inference object.
        diarization_data: Diarization JSON data with 'audio_file' and 'segments'.
        json_path: Path to the JSON file.
        min_duration: Minimum segment duration to process.
        cache: Optional embedding cache controller.

    Returns:
        Dict mapping speaker labels to pooled embeddings.
    """
    # Import Segment for time segment handling
    _require_pyannote()
    from pyannote.core import Segment

    audio_file = resolve_project_path(Path(diarization_data["audio_file"]))
    segments = diarization_data["segments"]
    segments_checksum = compute_segments_checksum(segments)

    # Get identifier from json path (hash directory name)
    file_identifier = json_path.parent.name

    print(f"\n{'=' * 60}")
    print(f"Processing: {file_identifier}")
    print(f"Audio file: {audio_file}")
    print(f"Segments: {len(segments)}")
    print("=" * 60)

    # Check if audio file exists
    if not audio_file.exists():
        print(f"Warning: Audio file not found: {audio_file}")
        print("Skipping this file...")
        return {}

    json_stat = json_path.stat()
    try:
        audio_stat = audio_file.stat()
    except FileNotFoundError:
        print(f"Warning: Audio file not accessible: {audio_file}")
        print("Skipping this file...")
        return {}

    cache_entry = None
    if cache and cache.enabled():
        cache_entry = cache.load(
            file_identifier=file_identifier,
            audio_file=audio_file,
            audio_stat=audio_stat,
            json_stat=json_stat,
            segments_checksum=segments_checksum,
        )
        if cache_entry.get("mode") == "file" and cache_entry.get("status") == "hit":
            print("  Cache hit (per-file) - skipping embedding extraction")
            return cache_entry["speaker_embeddings"]
        if cache_entry.get("mode") == "segment" and cache_entry.get("status") == "hit":
            cached_segments = cache_entry.get("segments_list", [])
            print(f"  Cache hit (per-segment) - reused {len(cached_segments)} embeddings")
            cached_embeddings, _ = EmbeddingCache.aggregate_segments(cached_segments)
            return cached_embeddings

    # Load waveform once so we avoid repeatedly streaming from disk per segment
    try:
        waveform, sample_rate = load_audio_with_soundfile(audio_file)
    except Exception as exc:
        print(f"Warning: Failed to load audio into memory: {exc}")
        print("Skipping this file...")
        return {}

    duration_seconds = waveform.shape[1] / sample_rate if waveform.shape[1] else 0.0
    print(
        f"Loaded audio into memory: {waveform.shape[0]} channel(s), "
        f"{duration_seconds:.1f}s @ {sample_rate} Hz"
    )

    # Reuse this descriptor for every crop so pyannote works on the in-memory tensor
    file_descriptor = {
        "waveform": waveform,
        "sample_rate": sample_rate,
        "uri": str(audio_file),
    }

    pooled: dict[str, list[np.ndarray]] = defaultdict(list)
    segment_durations: dict[str, list[float]] = defaultdict(list)
    durations: dict[str, float] = defaultdict(float)
    speaker_stats: dict[str, dict[str, float]] = {}
    skipped_count = 0
    processed_segments = 0
    segment_cache_hits = 0
    track_segments = cache is not None and cache.mode == "segment"
    segment_records: list[dict] = [] if track_segments else []
    segment_cache_map = (
        cache_entry.get("segment_map", {})
        if cache_entry and cache_entry.get("mode") == "segment"
        else {}
    )

    for seg_info in segments:
        start = seg_info["start"]
        end = seg_info["end"]
        speaker = seg_info["speaker"]

        segment = Segment(start, end)

        if segment.duration < min_duration:
            skipped_count += 1
            continue

        processed_segments += 1
        vector = None

        if segment_cache_map:
            key = segment_key(speaker, start, end)
            cached_entry = segment_cache_map.get(key)
            if cached_entry is not None:
                vector = cached_entry["vector"]
                segment_duration = cached_entry.get("duration", segment.duration)
                durations[speaker] += segment_duration
                segment_cache_hits += 1
            else:
                segment_duration = segment.duration
        else:
            segment_duration = segment.duration

        if vector is None:
            try:
                # Pyannote: use crop method
                embedding = inference.crop(file_descriptor, segment)

                if isinstance(embedding, torch.Tensor):
                    vector = embedding.detach().cpu().numpy()
                elif isinstance(embedding, np.ndarray):
                    vector = embedding
                else:
                    vector = np.asarray(embedding)

                durations[speaker] += segment_duration
                print(
                    f"  Extracted embedding for speaker_{speaker}: "
                    f"{start:.1f}s - {end:.1f}s ({segment.duration:.1f}s)"
                )
            except Exception as e:
                print(f"  Error extracting embedding for segment {start:.1f}s - {end:.1f}s: {e}")
                processed_segments -= 1
                continue

        pooled[speaker].append(vector)
        segment_durations[speaker].append(segment_duration)

        if track_segments:
            segment_records.append(
                {
                    "speaker": speaker,
                    "start": float(start),
                    "end": float(end),
                    "duration": float(segment_duration),
                    "vector": vector,
                }
            )

    if skipped_count > 0:
        print(f"  Skipped {skipped_count} short segment(s) (< {min_duration}s)")
    if segment_cache_hits and processed_segments:
        print(f"  Segment cache reuse: {segment_cache_hits}/{processed_segments} segment(s)")

    aggregated: dict[str, np.ndarray] = {}
    if pooled:
        print("\nPooling embeddings:")
        for speaker, vectors in pooled.items():
            if not vectors:
                continue

            # Stack and normalize before averaging
            stacked = np.stack(vectors, axis=0)
            norms = np.linalg.norm(stacked, axis=1, keepdims=True).clip(min=1e-12)
            normed = stacked / norms

            weights = np.asarray(segment_durations[speaker], dtype=np.float32)
            weight_sum = float(weights.sum())
            if weight_sum <= 0:
                pooled_vector = normed.mean(axis=0)
            else:
                pooled_vector = (normed * weights[:, None]).sum(axis=0) / weight_sum
            pooled_vector /= np.linalg.norm(pooled_vector) + 1e-12

            aggregated[speaker] = pooled_vector
            speaker_stats[speaker] = {
                "num_segments": len(vectors),
                "total_duration": durations[speaker],
            }

            print(
                f"  Speaker_{speaker}: pooled from {len(vectors)} segment(s) "
                f"({durations[speaker]:.1f}s total)"
            )
    else:
        print("\n  No embeddings extracted (all segments too short or errors occurred)")
        return {}

    if cache:
        if cache.mode == "file":
            cache.save_file_embeddings(
                file_identifier=file_identifier,
                audio_file=audio_file,
                audio_stat=audio_stat,
                json_stat=json_stat,
                segments_checksum=segments_checksum,
                speaker_embeddings=aggregated,
                speaker_stats=speaker_stats,
            )
        elif cache.mode == "segment":
            cache.save_segment_embeddings(
                file_identifier=file_identifier,
                audio_file=audio_file,
                audio_stat=audio_stat,
                json_stat=json_stat,
                segments_checksum=segments_checksum,
                segment_records=segment_records,
            )

    return aggregated


def build_embedding_map(
    inference: Any,  # pyannote Inference - but lazy loaded
    json_files: list[Path],
    min_duration: float = 1.0,
    cache: EmbeddingCache | None = None,
) -> EmbeddingMap:
    """Create pooled embeddings for each speaker from diarization JSON files.

    Processes multiple diarization files and builds a unified embedding map
    where each speaker is identified by (file_identifier, speaker_label).

    NOTE: This function requires pyannote-audio in the current runtime.

    Args:
        inference: Pyannote Inference object.
        json_files: List of paths to speakers.json files.
        min_duration: Minimum segment duration to process.
        cache: Optional embedding cache controller.

    Returns:
        Dict mapping (file_id, speaker) tuples to embedding vectors.
    """
    embeddings: EmbeddingMap = {}

    print("\n" + "=" * 60)
    print("Processing diarization files...")
    print("=" * 60)

    for json_path in json_files:
        try:
            diarization_data = load_diarization_json(json_path)
            speaker_embeddings = pool_embeddings(
                inference,
                diarization_data,
                json_path,
                min_duration,
                cache=cache,
            )

            # Use hash directory name as file identifier
            file_identifier = json_path.parent.name

            for speaker, vector in speaker_embeddings.items():
                embeddings[(file_identifier, speaker)] = vector

        except Exception as e:
            print(f"\nError processing {json_path}: {e}")
            traceback.print_exc()
            continue

    return embeddings
