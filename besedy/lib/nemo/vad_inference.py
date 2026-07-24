"""Inference-stage helpers for the NeMo VAD pipeline."""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

import numpy as np
import torch
from nemo.collections.asr.models import EncDecFrameClassificationModel
from nemo.collections.asr.parts.utils.vad_utils import get_vad_stream_status
from tqdm.auto import tqdm

from besedy.config.settings import config


def _configured_num_workers(vad_cfg: dict | None, *, default: int) -> int:
    """Resolve VAD worker count, allowing a Docker-safe env override."""

    override = os.getenv("BESEDY_NEMO_VAD_NUM_WORKERS")
    if override:
        try:
            return max(int(override), 0)
        except ValueError:
            logging.warning("Ignoring invalid BESEDY_NEMO_VAD_NUM_WORKERS=%r", override)

    if vad_cfg:
        return max(int(vad_cfg.get("num_workers", default)), 0)
    return default


def _extract_vad_features(
    manifest_path: Path,
    entries: list[dict],
    vad_model: EncDecFrameClassificationModel,
    vad_cfg: dict | None,
    workspace_dir: Path,
) -> Path:
    """Materialise NeMo-compatible feature tensors for VAD inference."""
    feature_manifest = workspace_dir / "manifest_vad_features.json"
    if feature_manifest.exists():
        return feature_manifest

    if not entries:
        return manifest_path

    feature_dir = workspace_dir / "vad_features"
    feature_dir.mkdir(parents=True, exist_ok=True)

    test_data_config = {
        "vad_stream": False,
        "manifest_filepath": str(manifest_path),
        "labels": ["infer"],
        "num_workers": _configured_num_workers(vad_cfg, default=4),
        "shuffle": False,
        "batch_size": 1,
        "sample_rate": config.audio.sample_rate,
        "normalize_audio_db": (vad_cfg or {})
        .get("vad", {})
        .get("parameters", {})
        .get("normalize_audio_db"),
    }
    vad_model.setup_test_data(test_data_config=test_data_config, use_feat=False)

    dataloader = vad_model.test_dataloader()
    if len(entries) != len(dataloader):
        logging.warning(
            "VAD feature extraction manifest entries (%d) do not match dataloader batches (%d).",
            len(entries),
            len(dataloader),
        )

    feature_manifest_entries: list[dict] = [dict(entry["record"]) for entry in entries]

    logging.info(
        "Extracting VAD features for %d audio chunks (this may take a while)...", len(entries)
    )
    with torch.no_grad():
        for idx, batch in enumerate(
            tqdm(
                dataloader,
                desc="Extracting VAD features",
                unit="chunk",
                total=len(entries),
                ncols=100,
                file=sys.stderr,
                disable=False,
            )
        ):
            meta_index = min(idx, len(entries) - 1)
            entry = entries[meta_index]
            meta = feature_manifest_entries[meta_index]
            alias = entry["alias"]

            tensors = [item.to(vad_model.device) for item in batch]
            with torch.amp.autocast(vad_model.device.type):
                processed_signal, processed_signal_length = vad_model.preprocessor(
                    input_signal=tensors[0],
                    length=tensors[1],
                )
            processed_signal = processed_signal.squeeze(0)
            length = (
                int(processed_signal_length.item())
                if isinstance(processed_signal_length, torch.Tensor)
                else int(processed_signal_length)
            )
            if length > 0:
                processed_signal = processed_signal[:, :length]
            feature_path = feature_dir / f"{alias}.pt"
            torch.save(processed_signal.cpu(), feature_path)
            meta["feature_file"] = str(feature_path)
            entry["record"]["feature_file"] = str(feature_path)
            del tensors

    with feature_manifest.open("w", encoding="utf-8") as fout:
        for entry in feature_manifest_entries:
            fout.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return feature_manifest


def _generate_vad_frame_predictions(
    vad_model: EncDecFrameClassificationModel,
    manifest_path: Path,
    entries: list[dict],
    window_length_in_sec: float,
    shift_length_in_sec: float,
    frame_dir: Path,
    use_feat: bool,
) -> None:
    """Stream VAD over the prepared manifest, writing frame-level probabilities."""
    frame_dir.mkdir(parents=True, exist_ok=True)
    stream_keys = [entry["group_id"] for entry in entries]
    statuses = get_vad_stream_status(stream_keys)
    time_unit = int(window_length_in_sec / shift_length_in_sec) if shift_length_in_sec else 0
    trunc = time_unit // 2 if time_unit else 0
    trunc_l = time_unit - trunc if time_unit else 0

    dataloader = vad_model.test_dataloader()
    total_batches = len(entries)
    if len(entries) != len(dataloader):
        logging.warning(
            "Mismatch between manifest entries (%d) and VAD dataloader batches (%d).",
            len(entries),
            len(dataloader),
        )

    logging.info(
        "Starting VAD inference on %d audio chunks (this may take a while)...", total_batches
    )

    for batch_idx, test_batch in enumerate(
        tqdm(
            dataloader,
            desc="VAD inference",
            unit="chunk",
            total=total_batches,
            ncols=100,
            file=sys.stderr,
            disable=False,
        )
    ):
        meta_index = min(batch_idx, len(entries) - 1)
        alias = entries[meta_index]["alias"]
        status = statuses[batch_idx] if batch_idx < len(statuses) else "single"
        test_batch = [x.to(vad_model.device) for x in test_batch]
        with torch.no_grad():
            with torch.amp.autocast(vad_model.device.type):
                if use_feat:
                    logits = vad_model(
                        processed_signal=test_batch[0],
                        processed_signal_length=test_batch[1],
                    )
                else:
                    logits = vad_model(
                        input_signal=test_batch[0],
                        input_signal_length=test_batch[1],
                    )
        probs = torch.softmax(logits, dim=-1)
        if probs.ndim == 3:
            probs = probs.squeeze(0)
        speech_prob = probs[:, 1]

        if window_length_in_sec == 0 or time_unit == 0:
            trimmed = speech_prob
        elif status == "start":
            trimmed = speech_prob[:-trunc] if trunc else speech_prob
        elif status == "next":
            trimmed = speech_prob[trunc:-trunc_l] if trunc_l else speech_prob[trunc:]
        elif status == "end":
            trimmed = speech_prob[trunc_l:] if trunc_l else speech_prob
        else:
            trimmed = speech_prob

        values = trimmed.detach().cpu().tolist()
        if not values:
            raise ValueError(f"VAD produced empty values for batch {batch_idx}, alias {alias}")
        frame_path = frame_dir / f"{alias}.frame"
        with frame_path.open("a", encoding="utf-8") as fout:
            for value in values:
                fout.write(f"{value:0.4f}\n")


def _load_frame_sequences(frame_dir: Path) -> dict[str, np.ndarray]:
    """Load frame probability sequences from .frame files."""
    frames: dict[str, np.ndarray] = {}
    if not frame_dir.exists():
        return frames
    for frame_file in frame_dir.glob("*.frame"):
        with frame_file.open("r", encoding="utf-8") as handle:
            values = [float(line.strip()) for line in handle if line.strip()]
        frames[frame_file.stem] = np.asarray(values, dtype=np.float32)
    return frames


def _parse_rttm_segments(
    segment_dir: Path,
    frame_sequences: dict[str, np.ndarray],
    frame_length_in_sec: float,
) -> dict[str, list[dict]]:
    """Parse RTTM files and compute mean probabilities for each segment."""
    segments_map: dict[str, list[dict]] = {}
    if not segment_dir.exists():
        return segments_map
    for rttm_file in segment_dir.glob("*.rttm"):
        alias = rttm_file.stem
        seq = frame_sequences.get(alias)
        alias_segments: list[dict] = []
        with rttm_file.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip() or line.startswith("#"):
                    continue
                parts = line.strip().split()
                if len(parts) < 5 or parts[0].upper() != "SPEAKER":
                    logging.warning(
                        "Skipping malformed RTTM line in %s: %s", rttm_file, line.strip()
                    )
                    continue
                start = float(parts[3])
                duration = float(parts[4])
                end = start + duration
                mean_prob = 0.0
                if seq is not None and frame_length_in_sec > 0:
                    start_idx = int(start / frame_length_in_sec)
                    end_idx = max(start_idx + 1, int(np.ceil(end / frame_length_in_sec)))
                    end_idx = min(end_idx, len(seq))
                    start_idx = min(start_idx, len(seq) - 1) if len(seq) else 0
                    if len(seq) and end_idx > start_idx:
                        mean_prob = float(seq[start_idx:end_idx].mean())
                alias_segments.append(
                    {
                        "start": round(start, 3),
                        "end": round(end, 3),
                        "mean_prob": round(mean_prob, 4),
                    }
                )
        segments_map[alias] = alias_segments
    return segments_map
