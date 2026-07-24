"""VAD pipeline for NeMo transcription.

This module keeps the high-level VAD orchestration in one place while adjacent
`vad_*` modules own manifest preparation, inference materialization, and debug
artifact helpers.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any

from nemo.collections.asr.models import EncDecFrameClassificationModel
from nemo.collections.asr.parts.utils.vad_utils import (
    generate_overlap_vad_seq,
    generate_vad_segment_table,
)

from besedy.config.settings import config
from besedy.lib.nemo.confidence import VadArtifacts, VadChunk
from besedy.lib.nemo.segments import (
    ChunkingParams,
    build_chunking_params,
    ensure_max_segment_length,
)
from besedy.lib.nemo.vad_debug import (
    build_postprocessing_params,
)
from besedy.lib.nemo.vad_inference import (
    _configured_num_workers,
    _extract_vad_features,
    _generate_vad_frame_predictions,
    _load_frame_sequences,
    _parse_rttm_segments,
)
from besedy.lib.nemo.vad_manifest import _prepare_vad_manifest, _write_manifest


def run_vad_segmentation(
    audio_files: list[Path],
    vad_model: EncDecFrameClassificationModel,
    vad_cfg: dict | None,
    args: Any,
    workspace_dir: Path | None = None,
) -> tuple[dict[Path, VadArtifacts], float, dict]:
    """Run complete VAD segmentation pipeline."""
    if not audio_files:
        return {}, 0.01, {}

    keep_vad_temp = getattr(args, "keep_vad_temp", False)

    def _execute(
        tmp_dir: Path, announce_cleanup: bool
    ) -> tuple[dict[Path, VadArtifacts], float, dict]:
        tmp_dir.mkdir(parents=True, exist_ok=True)
        if announce_cleanup:
            logging.info(
                "VAD workspace directory: %s (%s)",
                tmp_dir,
                "preserved" if keep_vad_temp else "will be cleaned up",
            )
        else:
            logging.info("VAD workspace directory: %s", tmp_dir)

        base_manifest_path = tmp_dir / "input_manifest.json"
        _write_manifest(audio_files, base_manifest_path)

        manifest_vad_path, chunk_entries = _prepare_vad_manifest(
            manifest_path=base_manifest_path,
            vad_cfg=vad_cfg,
            workspace_dir=tmp_dir,
        )
        manifest_feature_path = _extract_vad_features(
            manifest_path=manifest_vad_path,
            entries=chunk_entries,
            vad_model=vad_model,
            vad_cfg=vad_cfg,
            workspace_dir=tmp_dir,
        )

        window_length = (
            (vad_cfg or {}).get("vad", {}).get("parameters", {}).get("window_length_in_sec", 0.0)
        )
        shift_length = (
            (vad_cfg or {}).get("vad", {}).get("parameters", {}).get("shift_length_in_sec", 0.02)
        )

        test_data_config = {
            "vad_stream": True,
            "manifest_filepath": str(manifest_feature_path),
            "labels": ["infer"],
            "num_workers": _configured_num_workers(vad_cfg, default=4),
            "shuffle": False,
            "window_length_in_sec": window_length,
            "shift_length_in_sec": shift_length,
            "batch_size": 1,
            "sample_rate": config.audio.sample_rate,
            "normalize_audio_db": (vad_cfg or {})
            .get("vad", {})
            .get("parameters", {})
            .get("normalize_audio_db"),
        }
        vad_model.setup_test_data(test_data_config=test_data_config, use_feat=True)

        logging.info("VAD dataset setup complete. Preparing to run inference...")
        frame_dir = tmp_dir / "vad_frame_pred"
        logging.info("Calling _generate_vad_frame_predictions for %d chunks...", len(chunk_entries))
        _generate_vad_frame_predictions(
            vad_model=vad_model,
            manifest_path=Path(manifest_feature_path),
            entries=chunk_entries,
            window_length_in_sec=window_length,
            shift_length_in_sec=shift_length,
            frame_dir=frame_dir,
            use_feat=True,
        )
        logging.info("VAD frame predictions complete.")

        frame_length = shift_length if shift_length else 0.01
        smoothing_cfg = (vad_cfg or {}).get("vad", {}).get("parameters", {})
        if smoothing_cfg.get("smoothing"):
            smoothing_dir = generate_overlap_vad_seq(
                frame_pred_dir=str(frame_dir),
                smoothing_method=smoothing_cfg.get("smoothing"),
                overlap=smoothing_cfg.get("overlap", 0.875),
                window_length_in_sec=window_length,
                shift_length_in_sec=shift_length,
                num_workers=_configured_num_workers(vad_cfg, default=0),
                out_dir=(vad_cfg or {}).get("smoothing_out_dir"),
            )
            frame_dir = Path(smoothing_dir)
            frame_length = 0.01

        frame_sequences = _load_frame_sequences(frame_dir)
        postprocessing_params = build_postprocessing_params(args, vad_cfg or {})
        chunk_params: ChunkingParams | None = build_chunking_params(
            chunk_length=args.chunk_length,
            chunk_min_silence_ms=args.chunk_min_silence_ms,
            chunk_silence_threshold=args.chunk_silence_threshold,
            default_silence_threshold=float(postprocessing_params.get("offset", 0.35)),
        )
        if chunk_params is not None:
            setattr(args, "_chunking_params", chunk_params)
            setattr(args, "_chunking_effective_silence_threshold", chunk_params.silence_threshold)
        segment_dir = generate_vad_segment_table(
            vad_pred_dir=str(frame_dir),
            postprocessing_params=postprocessing_params,
            frame_length_in_sec=frame_length,
            num_workers=_configured_num_workers(vad_cfg, default=0),
            out_dir=(vad_cfg or {}).get("rttm_out_dir"),
            use_rttm=True,
        )

        segments_by_alias = _parse_rttm_segments(Path(segment_dir), frame_sequences, frame_length)

        aggregated_segments: dict[Path, list[dict]] = {}
        chunk_map: dict[Path, list[VadChunk]] = {}
        for entry in chunk_entries:
            alias = entry["alias"]
            resolved_path = entry["resolved_path"]
            offset = entry["offset"]
            duration = entry.get("duration")
            original_segments = segments_by_alias.get(alias, [])
            if chunk_params is not None:
                chunk_segments = ensure_max_segment_length(
                    original_segments,
                    frame_sequences.get(alias),
                    frame_length,
                    chunk_params,
                )
            else:
                chunk_segments = original_segments
            adjusted_segments: list[dict] = []
            local_segment_records: list[dict] = []
            for local_idx, seg in enumerate(chunk_segments):
                local_record = {
                    "start": seg["start"],
                    "end": seg["end"],
                    "mean_prob": seg["mean_prob"],
                    "local_index": local_idx,
                }
                local_segment_records.append(local_record)

                adjusted_segments.append(
                    {
                        "start": round(seg["start"] + offset, 3),
                        "end": round(seg["end"] + offset, 3),
                        "mean_prob": seg["mean_prob"],
                        "chunk_alias": alias,
                        "chunk_local_index": local_idx,
                    }
                )
            if adjusted_segments:
                aggregated_segments.setdefault(resolved_path, []).extend(adjusted_segments)

            rttm_path = Path(segment_dir) / f"{alias}.rttm" if segment_dir else None
            if rttm_path and not rttm_path.exists():
                rttm_path = None

            derived_duration = (
                max((seg["end"] for seg in chunk_segments), default=0.0) if chunk_segments else 0.0
            )
            if duration is None or (derived_duration and derived_duration > float(duration)):
                duration = derived_duration

            chunk = VadChunk(
                alias=alias,
                audio_path=resolved_path,
                offset=offset,
                duration=duration,
                segments=local_segment_records,
                rttm_path=rttm_path,
            )
            chunk_map.setdefault(resolved_path, []).append(chunk)

        for segments in aggregated_segments.values():
            segments.sort(key=lambda item: item["start"])

        artifact_map: dict[Path, VadArtifacts] = {}
        for audio_path in audio_files:
            resolved = audio_path.resolve()
            artifact_map[resolved] = VadArtifacts(
                segments=list(aggregated_segments.get(resolved, [])),
                chunks=sorted(chunk_map.get(resolved, []), key=lambda chunk: chunk.offset),
            )

        workspace_artifacts = {
            "workspace_dir": tmp_dir,
            "input_manifest": base_manifest_path,
            "manifest_vad": manifest_vad_path,
            "feature_manifest": manifest_feature_path,
            "frame_dir": frame_dir,
            "segment_dir": Path(segment_dir) if segment_dir else None,
        }

        return artifact_map, frame_length, workspace_artifacts

    if workspace_dir is not None:
        return _execute(workspace_dir, announce_cleanup=False)

    with tempfile.TemporaryDirectory(prefix="nemo_vad_", delete=not keep_vad_temp) as tmp_dir_str:
        return _execute(Path(tmp_dir_str), announce_cleanup=True)
