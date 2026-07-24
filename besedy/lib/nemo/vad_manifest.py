"""Manifest preparation helpers for the NeMo VAD pipeline."""

from __future__ import annotations

import json
from pathlib import Path

import nemo.collections.asr.parts.utils.vad_utils as nemo_vad_utils
import soundfile as sf
from nemo.collections.asr.parts.utils.vad_utils import prepare_manifest

from besedy.lib.workflow.paths import sanitize_model_identifier

_FAST_MANIFEST_PATCHED = False


def _probe_audio_duration(audio_path: Path) -> float | None:
    """Get audio duration using soundfile without loading full waveform."""
    info = sf.info(str(audio_path))
    if info.frames == 0:
        raise ValueError(f"Audio file has zero frames: {audio_path}")
    if info.samplerate == 0:
        raise ValueError(f"Audio file has zero sample rate: {audio_path}")
    return float(info.frames) / float(info.samplerate)


def _write_manifest(audio_files: list[Path], manifest_path: Path) -> dict[Path, str]:
    """Write a minimal NeMo-compatible manifest covering the provided audio files."""
    alias_map: dict[Path, str] = {}
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as handle:
        for idx, audio_path in enumerate(audio_files):
            resolved = audio_path.resolve()
            alias = f"{idx:04d}_{sanitize_model_identifier(resolved.stem)}"
            duration = _probe_audio_duration(resolved)
            alias_map[resolved] = alias
            entry = {
                "audio_filepath": str(resolved),
                "offset": 0.0,
                "duration": round(duration, 6) if duration is not None else None,
                "label": "infer",
                "text": "-",
            }
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return alias_map


def _write_vad_infer_manifest_fast(file: dict, args_func: dict) -> list:
    """Fast implementation of NeMo's manifest splitting for VAD inference."""
    original = getattr(nemo_vad_utils, "_ORIG_write_vad_infer_manifest", None)
    if original is None:
        raise RuntimeError("NeMo VAD manifest helper not initialised before patching.")

    duration_val = file.get("duration")
    if duration_val is None:
        raise ValueError(f"Missing duration field in manifest entry: {file}")

    duration_val = float(duration_val)
    if duration_val <= 0:
        raise ValueError(f"Invalid duration value ({duration_val}) in manifest entry: {file}")

    res: list[dict] = []
    label = args_func["label"]
    split_duration = float(args_func["split_duration"])
    window_length_in_sec = float(args_func["window_length_in_sec"])
    filepath = file["audio_filepath"]
    in_offset = float(file.get("offset", 0.0) or 0.0)

    path_obj = Path(filepath)
    if not path_obj.is_file():
        manifest_dir = args_func.get("manifest_dir")
        if manifest_dir:
            candidate = Path(manifest_dir) / Path(filepath)
            if candidate.is_file():
                path_obj = candidate.resolve()
    if not path_obj.is_file():
        return original(file, args_func)
    filepath = path_obj.as_posix()

    total_duration = _probe_audio_duration(path_obj)
    if total_duration is None:
        return original(file, args_func)

    max_available = float(total_duration) - in_offset
    if max_available <= 0:
        return original(file, args_func)

    left = min(float(duration_val), max_available)
    if left <= 0:
        return original(file, args_func)

    current_offset = in_offset
    status = "single"

    while left > 0:
        if left <= split_duration:
            if status == "single":
                write_duration = left
                current_offset = 0
            else:
                status = "end"
                write_duration = left + window_length_in_sec
                current_offset -= window_length_in_sec
            offset_inc = left
            left = 0
        else:
            if status in ("start", "next"):
                status = "next"
            else:
                status = "start"

            if status == "start":
                write_duration = split_duration
                offset_inc = split_duration
            else:
                write_duration = split_duration + window_length_in_sec
                current_offset -= window_length_in_sec
                offset_inc = split_duration + window_length_in_sec

            left -= split_duration

        metadata = {
            "audio_filepath": filepath,
            "duration": write_duration,
            "label": label,
            "text": "_",
            "offset": current_offset,
        }
        res.append(metadata)
        current_offset += offset_inc

    return res


def _write_vad_infer_manifest_fast_star(args: tuple) -> list:
    """Wrapper for multiprocessing compatibility."""
    return _write_vad_infer_manifest_fast(*args)


def _ensure_fast_manifest_split() -> None:
    """Patch NeMo's manifest splitting with our fast implementation."""
    global _FAST_MANIFEST_PATCHED
    if _FAST_MANIFEST_PATCHED:
        return

    if not hasattr(nemo_vad_utils, "_ORIG_write_vad_infer_manifest"):
        nemo_vad_utils._ORIG_write_vad_infer_manifest = nemo_vad_utils.write_vad_infer_manifest

    nemo_vad_utils.write_vad_infer_manifest = _write_vad_infer_manifest_fast
    nemo_vad_utils.write_vad_infer_manifest_star = _write_vad_infer_manifest_fast_star
    _FAST_MANIFEST_PATCHED = True


def _prepare_vad_manifest(
    manifest_path: Path,
    vad_cfg: dict | None,
    workspace_dir: Path,
) -> tuple[Path, list[dict]]:
    """Optionally split long audio entries according to NeMo's prepare_manifest."""
    _ensure_fast_manifest_split()
    prepare_cfg = (vad_cfg or {}).get("prepare_manifest", {})
    manifest_vad_path = manifest_path
    if prepare_cfg.get("auto_split", True):
        prepared_path = workspace_dir / "manifest_vad_input.json"
        config = {
            "input": str(manifest_path),
            "window_length_in_sec": (vad_cfg or {})
            .get("vad", {})
            .get("parameters", {})
            .get("window_length_in_sec", 0.0),
            "split_duration": prepare_cfg.get("split_duration", 400),
            "num_workers": vad_cfg.get("num_workers", 0) if vad_cfg else 0,
            "prepared_manifest_vad_input": str(prepared_path),
            "out_dir": str(workspace_dir),
        }
        manifest_vad_path = Path(prepare_manifest(config))
    else:
        manifest_vad_path = manifest_path

    entries: list[dict] = []
    with Path(manifest_vad_path).open("r", encoding="utf-8") as handle:
        for idx, line in enumerate(handle):
            if not line.strip():
                continue
            record = json.loads(line)
            resolved = Path(record["audio_filepath"]).resolve()
            alias = f"{idx:06d}_{sanitize_model_identifier(resolved.stem)}"
            group_id = str(resolved)
            entry = {
                "alias": alias,
                "audio_filepath": str(resolved),
                "resolved_path": resolved,
                "offset": float(record.get("offset", 0.0) or 0.0),
                "duration": float(record["duration"])
                if record.get("duration") not in (None, "")
                else None,
                "group_id": group_id,
                "record": record,
            }
            entries.append(entry)
    return Path(manifest_vad_path), entries
