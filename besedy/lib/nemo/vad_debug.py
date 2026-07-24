"""Debug-artifact helpers for the NeMo VAD pipeline."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from besedy.config.settings import config
from besedy.lib.nemo.confidence import VadArtifacts, VadChunk


def build_postprocessing_params(args: Any, vad_cfg: dict) -> dict:
    """Extract and validate VAD postprocessing parameters."""
    params = (
        vad_cfg.get("vad", {}).get("parameters", {}).get("postprocessing", {}) if vad_cfg else {}
    )
    params = dict(params) if params else {}
    required = (
        "onset",
        "offset",
        "min_duration_on",
        "min_duration_off",
        "pad_onset",
        "pad_offset",
    )
    missing = [key for key in required if params.get(key) is None]
    if missing:
        raise ValueError(
            "VAD postprocessing config is missing required field(s): " + ", ".join(sorted(missing))
        )
    setattr(args, "_vad_postprocessing_params", dict(params))
    return params


def build_chunk_metadata(chunks: list[VadChunk], total_duration: float) -> list[dict]:
    """Summarize VAD chunks with consistent timing/sample fields."""
    if not chunks:
        sample_end = int(round(total_duration * config.audio.sample_rate))
        return [
            {
                "idx": 0,
                "position": 1,
                "offset": 0.0,
                "duration": total_duration,
                "time_start": 0.0,
                "time_end": total_duration,
                "sample_start": 0,
                "sample_end": sample_end,
                "segments": [],
                "absolute_segments": [],
            }
        ]

    metadata: list[dict] = []
    for idx, chunk in enumerate(chunks):
        chunk_start = float(chunk.offset or 0.0)
        if chunk.duration is not None:
            local_duration = float(chunk.duration)
        elif chunk.segments:
            local_duration = max((seg.get("end", 0.0) or 0.0) for seg in chunk.segments)
        else:
            local_duration = 0.0
        chunk_end = chunk_start + local_duration
        local_segments = (
            [
                {
                    "start": seg.get("start", 0.0),
                    "end": seg.get("end", seg.get("start", 0.0)),
                    "mean_prob": seg.get("mean_prob"),
                    "local_index": seg.get("local_index"),
                }
                for seg in chunk.segments
            ]
            if chunk.segments
            else []
        )
        absolute_segments = (
            [
                {
                    "start": round(chunk_start + seg.get("start", 0.0), 3),
                    "end": round(chunk_start + seg.get("end", 0.0), 3),
                    "mean_prob": seg.get("mean_prob"),
                    "chunk_alias": chunk.alias,
                    "chunk_local_index": seg.get("local_index"),
                }
                for seg in chunk.segments
            ]
            if chunk.segments
            else []
        )
        metadata.append(
            {
                "idx": idx,
                "position": idx + 1,
                "offset": chunk_start,
                "duration": local_duration,
                "time_start": chunk_start,
                "time_end": chunk_end,
                "sample_start": int(round(chunk_start * config.audio.sample_rate)),
                "sample_end": int(round(chunk_end * config.audio.sample_rate)),
                "segments": local_segments,
                "absolute_segments": absolute_segments,
            }
        )
    return metadata


def persist_vad_debug_artifacts(
    target_dir: Path,
    manifests: dict,
    artifacts: VadArtifacts,
    chunk_metadata: list[dict],
) -> None:
    """Copy manifest/segment data into a durable per-audio directory."""
    target_dir.mkdir(parents=True, exist_ok=True)

    segments_path = target_dir / "segments.json"
    segments_path.write_text(
        json.dumps(artifacts.segments, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    chunks_path = target_dir / "chunks.json"
    chunks_path.write_text(
        json.dumps(chunk_metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    manifest_dir = target_dir / "manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    for key in ("input_manifest", "manifest_vad", "feature_manifest"):
        src = manifests.get(key)
        if not src:
            continue
        src_path = Path(src)
        if not src_path.exists():
            continue
        shutil.copy2(src_path, manifest_dir / src_path.name)

    if artifacts.chunks:
        rttm_dir = target_dir / "rttm"
        rttm_dir.mkdir(parents=True, exist_ok=True)
        for chunk in artifacts.chunks:
            if chunk.rttm_path and chunk.rttm_path.exists():
                shutil.copy2(chunk.rttm_path, rttm_dir / f"{chunk.alias}.rttm")
