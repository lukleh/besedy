"""Embedding cache for speaker clustering.

This module provides the EmbeddingCache class for caching extracted
speaker embeddings to avoid redundant computation.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from besedy.lib.data.encoding import load_json_with_fallback
from besedy.lib.speakers.utils import round_time, segment_key


class EmbeddingCache:
    """Cache extracted embeddings per diarization file or per segment.

    Supports two modes:
    - "file": Cache aggregated speaker embeddings per diarization file
    - "segment": Cache individual segment embeddings for partial reuse

    Attributes:
        VERSION: Cache format version for invalidation on format changes.
        mode: Caching mode ("none", "file", or "segment").
        model_name: Name of the embedding model.
        min_duration: Minimum segment duration used during extraction.
        refresh: If True, ignore existing cache and recompute.
        base_dir: Base directory for cache files.
    """

    VERSION = 1

    def __init__(
        self,
        mode: str,
        cache_dir: Path,
        model_name: str,
        min_duration: float,
        refresh: bool = False,
    ):
        """Initialize the embedding cache.

        Args:
            mode: Caching mode ("none", "file", or "segment").
            cache_dir: Base directory for cache storage.
            model_name: Name of the embedding model.
            min_duration: Minimum segment duration for extraction.
            refresh: If True, ignore existing cache.
        """
        self.mode = mode
        self.model_name = model_name
        self.min_duration = min_duration
        self.refresh = refresh
        if self.mode != "none":
            self.base_dir = (cache_dir / model_name / mode).resolve()
            self.base_dir.mkdir(parents=True, exist_ok=True)
        else:
            self.base_dir = None

    def enabled(self) -> bool:
        """Check if caching is enabled."""
        return self.mode != "none"

    def _cache_file(self, file_identifier: str) -> Path | None:
        """Get the cache file path for a given file identifier."""
        if not self.enabled() or not self.base_dir:
            return None
        file_dir = self.base_dir / file_identifier
        file_dir.mkdir(parents=True, exist_ok=True)
        return file_dir / "embeddings.json"

    @staticmethod
    def _same_path(stored_path: str | None, actual_path: Path) -> bool:
        """Check if stored path matches actual path."""
        if not stored_path:
            return False
        try:
            return Path(stored_path).resolve() == actual_path.resolve()
        except FileNotFoundError:
            return False

    @staticmethod
    def _same_float(stored: float | None, current: float, tolerance: float = 1e-3) -> bool:
        """Check if stored float matches current within tolerance."""
        if stored is None:
            return False
        return abs(float(stored) - float(current)) <= tolerance

    def load(
        self,
        file_identifier: str,
        audio_file: Path,
        audio_stat: os.stat_result,
        json_stat: os.stat_result,
        segments_checksum: str,
    ) -> dict:
        """Load cached embeddings if metadata matches.

        Args:
            file_identifier: Unique identifier for the file (e.g., hash directory name).
            audio_file: Path to the audio file.
            audio_stat: Stat result for the audio file.
            json_stat: Stat result for the JSON file.
            segments_checksum: Checksum of the diarization segments.

        Returns:
            Dict with status and cached data. Status can be:
            - "disabled": Caching is disabled
            - "miss": No valid cache found
            - "hit": Full cache hit
            - "partial": Partial cache hit (segment mode only)
        """
        if not self.enabled():
            return {"status": "disabled"}

        cache_file = self._cache_file(file_identifier)
        if cache_file is None or self.refresh or not cache_file.exists():
            return {"status": "miss"}

        try:
            payload = load_json_with_fallback(cache_file)
        except (ValueError, Exception) as exc:
            print(f"  Warning: Failed to read cache {cache_file}: {exc}")
            return {"status": "miss"}

        metadata = payload.get("metadata", {})
        if metadata.get("version") != self.VERSION:
            return {"status": "miss"}
        if metadata.get("mode") != self.mode:
            return {"status": "miss"}
        if metadata.get("model_name") != self.model_name:
            return {"status": "miss"}
        stored_min_duration = metadata.get("min_duration")
        if stored_min_duration is None or abs(stored_min_duration - self.min_duration) > 1e-6:
            return {"status": "miss"}
        if not self._same_path(metadata.get("audio_file"), audio_file):
            return {"status": "miss"}
        if not self._same_float(metadata.get("audio_mtime"), audio_stat.st_mtime):
            return {"status": "miss"}
        if metadata.get("audio_size") != audio_stat.st_size:
            return {"status": "miss"}
        if not self._same_float(metadata.get("json_mtime"), json_stat.st_mtime):
            return {"status": "miss"}

        stored_checksum = metadata.get("segments_checksum")

        if self.mode == "file":
            if stored_checksum != segments_checksum:
                return {"status": "miss"}

            speaker_map = {}
            for speaker, entry in payload.get("speakers", {}).items():
                vector = np.asarray(entry.get("vector", []), dtype=np.float32)
                speaker_map[speaker] = vector
            return {
                "status": "hit",
                "mode": "file",
                "speaker_embeddings": speaker_map,
                "cache_file": cache_file,
            }

        # segment mode
        segments_list = []
        segment_map = {}
        for entry in payload.get("segments", []):
            vector = np.asarray(entry.get("vector", []), dtype=np.float32)
            record = {
                "speaker": entry.get("speaker"),
                "start": float(entry.get("start", 0.0)),
                "end": float(entry.get("end", 0.0)),
                "duration": float(
                    entry.get("duration", entry.get("end", 0.0) - entry.get("start", 0.0))
                ),
                "vector": vector,
            }
            key = segment_key(record["speaker"], record["start"], record["end"])
            segment_map[key] = record
            segments_list.append(record)

        status = "hit" if stored_checksum == segments_checksum else "partial"
        return {
            "status": status,
            "mode": "segment",
            "segment_map": segment_map,
            "segments_list": segments_list,
            "cache_file": cache_file,
        }

    def save_file_embeddings(
        self,
        file_identifier: str,
        audio_file: Path,
        audio_stat: os.stat_result,
        json_stat: os.stat_result,
        segments_checksum: str,
        speaker_embeddings: dict[str, np.ndarray],
        speaker_stats: dict[str, dict[str, float]],
    ) -> None:
        """Save aggregated speaker embeddings to cache.

        Args:
            file_identifier: Unique identifier for the file.
            audio_file: Path to the audio file.
            audio_stat: Stat result for the audio file.
            json_stat: Stat result for the JSON file.
            segments_checksum: Checksum of the diarization segments.
            speaker_embeddings: Dict mapping speaker to embedding vector.
            speaker_stats: Dict mapping speaker to statistics.
        """
        if not self.enabled() or self.mode != "file" or not speaker_embeddings:
            return

        cache_file = self._cache_file(file_identifier)
        if cache_file is None:
            return

        serializable = {
            speaker: {
                "vector": vector.tolist(),
                **speaker_stats.get(speaker, {}),
            }
            for speaker, vector in speaker_embeddings.items()
        }

        payload = {
            "metadata": {
                "version": self.VERSION,
                "mode": self.mode,
                "model_name": self.model_name,
                "min_duration": self.min_duration,
                "audio_file": str(audio_file),
                "audio_mtime": round_time(audio_stat.st_mtime),
                "audio_size": audio_stat.st_size,
                "json_mtime": round_time(json_stat.st_mtime),
                "segments_checksum": segments_checksum,
                "updated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            },
            "speakers": serializable,
        }

        with cache_file.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)

    def save_segment_embeddings(
        self,
        file_identifier: str,
        audio_file: Path,
        audio_stat: os.stat_result,
        json_stat: os.stat_result,
        segments_checksum: str,
        segment_records: list[dict],
    ) -> None:
        """Save individual segment embeddings to cache.

        Args:
            file_identifier: Unique identifier for the file.
            audio_file: Path to the audio file.
            audio_stat: Stat result for the audio file.
            json_stat: Stat result for the JSON file.
            segments_checksum: Checksum of the diarization segments.
            segment_records: List of segment records with embeddings.
        """
        if not self.enabled() or self.mode != "segment" or not segment_records:
            return

        cache_file = self._cache_file(file_identifier)
        if cache_file is None:
            return

        serializable_segments = [
            {
                "speaker": record["speaker"],
                "start": float(record["start"]),
                "end": float(record["end"]),
                "duration": float(record.get("duration", record["end"] - record["start"])),
                "vector": record["vector"].tolist(),
            }
            for record in segment_records
        ]

        payload = {
            "metadata": {
                "version": self.VERSION,
                "mode": self.mode,
                "model_name": self.model_name,
                "min_duration": self.min_duration,
                "audio_file": str(audio_file),
                "audio_mtime": round_time(audio_stat.st_mtime),
                "audio_size": audio_stat.st_size,
                "json_mtime": round_time(json_stat.st_mtime),
                "segments_checksum": segments_checksum,
                "updated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            },
            "segments": serializable_segments,
        }

        with cache_file.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)

    @staticmethod
    def aggregate_segments(
        segment_records: list[dict],
    ) -> tuple[dict[str, np.ndarray], dict[str, dict[str, float]]]:
        """Aggregate per-segment embeddings into per-speaker embeddings.

        Uses duration-weighted averaging of L2-normalized embeddings.

        Args:
            segment_records: List of segment records with speaker, vector, duration.

        Returns:
            Tuple of (speaker_embeddings, speaker_stats) dicts.
        """
        pooled: dict[str, list[np.ndarray]] = defaultdict(list)
        segment_durations: dict[str, list[float]] = defaultdict(list)
        durations: dict[str, float] = defaultdict(float)
        for record in segment_records:
            pooled[record["speaker"]].append(record["vector"])
            duration = record.get("duration")
            if duration is None:
                duration = float(record.get("end", 0.0)) - float(record.get("start", 0.0))
            duration = float(duration)
            segment_durations[record["speaker"]].append(duration)
            durations[record["speaker"]] += duration

        aggregated: dict[str, np.ndarray] = {}
        stats: dict[str, dict[str, float]] = {}
        for speaker, vectors in pooled.items():
            if not vectors:
                continue
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
            stats[speaker] = {
                "num_segments": len(vectors),
                "total_duration": durations[speaker],
            }
        return aggregated, stats
