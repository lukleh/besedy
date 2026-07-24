#!/usr/bin/env python3
"""One-off faster-whisper transcription without catalog registration.

Usage:
    uv run python besedy/cli/transcribe_oneoff.py /path/to/audio.mp3

By default this writes these files next to each input audio file:
    <audio-stem>.transcript.json
    <audio-stem>.transcript.txt
    <audio-stem>.transcript.srt
    <audio-stem>.transcript.vtt
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from besedy.lib.analysis.stats import extract_transcript_text
from besedy.lib.analysis.subtitles import render_srt, render_vtt
from besedy.lib.analysis.timeline import Segment, extract_segments
from besedy.lib.data.encoding import load_json_with_fallback
from besedy.lib.workflow.language import (
    LEGACY_DEFAULT_LANGUAGE,
    resolve_inference_language,
    resolve_language_setting,
)

FALLBACK_MODEL = "large-v3"
FALLBACK_VAD_MODEL = "silero_vad_v6"
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_OUTPUT_SUFFIX = ".transcript"


class MissingFasterWhisperRuntimeError(RuntimeError):
    """Raised when faster-whisper is unavailable in the current Python runtime."""


@dataclass(frozen=True)
class OneOffDefaults:
    model_name: str = FALLBACK_MODEL
    vad_model: str | None = FALLBACK_VAD_MODEL
    language: str = LEGACY_DEFAULT_LANGUAGE
    vad_filter: bool = True
    word_timestamps: bool = True
    min_silence_ms: int | None = None


@dataclass(frozen=True)
class OutputPaths:
    json: Path
    txt: Path
    srt: Path
    vtt: Path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Transcribe audio file(s) with faster-whisper and write transcript files "
            "next to the audio, without creating or updating any Besedy catalog."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "audio",
        type=Path,
        nargs="+",
        help="Audio file(s) to transcribe. Any format faster-whisper can decode is accepted.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Optional directory for outputs. Default: each audio file's parent directory.",
    )
    parser.add_argument(
        "--suffix",
        default=DEFAULT_OUTPUT_SUFFIX,
        help=(
            "Filename suffix inserted after the audio stem. Use an empty string to write "
            "<stem>.json/.txt/.srt/.vtt."
        ),
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Re-run transcription and overwrite existing JSON/sidecar outputs.",
    )
    parser.add_argument(
        "--runtime",
        choices=("auto", "host", "docker"),
        default="auto",
        help=(
            "Execution runtime. auto uses the host package if already installed, "
            "otherwise the configured faster-whisper Docker backend."
        ),
    )
    parser.add_argument(
        "--json-only",
        action="store_true",
        help="Only write canonical JSON; skip txt/srt/vtt sidecars.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help=(
            "faster-whisper model alias or local CTranslate2 model path. "
            "Default: configured faster-whisper model, or large-v3 if no config is available."
        ),
    )
    parser.add_argument(
        "--vad-model",
        default=None,
        help=(
            "VAD model label recorded in transcript metadata. Default: configured value, "
            "or silero_vad_v6 if no config is available."
        ),
    )
    parser.add_argument(
        "--device",
        default="cuda",
        help="Inference device passed to faster-whisper (cuda, cpu, auto).",
    )
    parser.add_argument(
        "--compute-type",
        default="float16",
        help="Compute type passed to faster-whisper (float16, int8, etc.).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=8,
        help="Batch size for BatchedInferencePipeline.transcribe.",
    )
    parser.add_argument(
        "--language",
        default=None,
        help=(
            "Language code forwarded to faster-whisper. Use 'auto' for language detection; "
            "defaults to the configured faster-whisper workflow."
        ),
    )
    parser.add_argument(
        "--min-silence-ms",
        type=int,
        default=None,
        help="Minimum silence duration for faster-whisper VAD. Default: besedy.toml value.",
    )
    parser.add_argument(
        "--vad-filter",
        dest="vad_filter",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Enable or disable faster-whisper VAD filtering.",
    )
    parser.add_argument(
        "--word-timestamps",
        dest="word_timestamps",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Enable or disable word-level timestamps.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print debug logging.",
    )
    return parser.parse_args(argv)


def ensure_audio_files(paths: list[Path]) -> list[Path]:
    resolved: list[Path] = []
    for audio_path in paths:
        candidate = audio_path.expanduser().resolve()
        if not candidate.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        if not candidate.is_file():
            raise ValueError(f"Audio path is not a file: {audio_path}")
        resolved.append(candidate)
    return resolved


def _normalize_suffix(value: str) -> str:
    suffix = value.strip()
    if not suffix:
        return ""
    if "/" in suffix or "\\" in suffix:
        raise ValueError("--suffix must be a filename suffix, not a path")
    return suffix if suffix.startswith(".") else f".{suffix}"


def resolve_output_paths(
    audio_path: Path,
    *,
    output_dir: Path | None = None,
    suffix: str = DEFAULT_OUTPUT_SUFFIX,
) -> OutputPaths:
    resolved_audio = audio_path.expanduser().resolve()
    target_dir = output_dir.expanduser().resolve() if output_dir else resolved_audio.parent
    suffix = _normalize_suffix(suffix)
    base_name = f"{resolved_audio.stem}{suffix}"
    return OutputPaths(
        json=target_dir / f"{base_name}.json",
        txt=target_dir / f"{base_name}.txt",
        srt=target_dir / f"{base_name}.srt",
        vtt=target_dir / f"{base_name}.vtt",
    )


def _assert_unique_outputs(outputs: dict[Path, OutputPaths]) -> None:
    seen: dict[Path, Path] = {}
    for audio_path, paths in outputs.items():
        existing = seen.get(paths.json)
        if existing is not None:
            raise ValueError(
                "Multiple inputs would write the same transcript JSON: "
                f"{existing} and {audio_path} -> {paths.json}"
            )
        seen[paths.json] = audio_path


def resolve_defaults() -> OneOffDefaults:
    try:
        from besedy.config.settings import get_config
        from besedy.lib.workflow.config import get_transcription_workflows
    except Exception:
        return OneOffDefaults()

    try:
        app_config = get_config()
        workflows = get_transcription_workflows(workflow_id="faster-whisper")
    except FileNotFoundError:
        return OneOffDefaults()

    workflow = workflows[0] if workflows else None
    return OneOffDefaults(
        model_name=workflow.model_name if workflow else FALLBACK_MODEL,
        vad_model=workflow.vad_model if workflow else FALLBACK_VAD_MODEL,
        language=workflow.language if workflow else LEGACY_DEFAULT_LANGUAGE,
        vad_filter=bool(app_config.vad.filter_enabled),
        word_timestamps=bool(app_config.vad.word_timestamps),
        min_silence_ms=app_config.vad.min_silence_ms,
    )


def _load_faster_whisper_helpers() -> ModuleType:
    try:
        from besedy.workflows import transcribe_faster_whisper
    except ModuleNotFoundError as exc:
        if exc.name == "faster_whisper" or (exc.name or "").startswith("faster_whisper."):
            raise MissingFasterWhisperRuntimeError(
                "The faster-whisper package is not installed in this Python environment. "
                "Using the faster-whisper Docker backend instead."
            ) from exc
        raise
    return transcribe_faster_whisper


def _vad_model_label(vad_model: str | None) -> str | None:
    if not vad_model:
        return vad_model
    return vad_model if vad_model.endswith(".onnx") else f"{vad_model}.onnx"


def transcribe_audio(
    audio_path: Path,
    *,
    helpers: ModuleType,
    pipeline: Any,
    model_name: str,
    device: str,
    compute_type: str,
    language: str | None,
    batch_size: int,
    vad_filter: bool,
    min_silence_ms: int | None,
    word_timestamps: bool,
    vad_model: str | None,
) -> dict[str, Any]:
    logging.info("Extracting VAD segments from %s", audio_path.name)
    vad_segments = helpers.extract_vad_segments(
        audio_path,
        min_silence_duration_ms=min_silence_ms,
        sampling_rate=DEFAULT_SAMPLE_RATE,
    )
    logging.info("Found %d VAD speech segment(s)", len(vad_segments))

    vad_parameters = None
    if min_silence_ms is not None:
        vad_parameters = {"min_silence_duration_ms": min_silence_ms}

    segments_iter, info = pipeline.transcribe(
        str(audio_path),
        batch_size=batch_size,
        vad_filter=vad_filter,
        vad_parameters=vad_parameters,
        word_timestamps=word_timestamps,
        language=language,
        log_progress=True,
        condition_on_previous_text=False,
        repetition_penalty=1.1,
    )
    segments = list(segments_iter)
    return helpers.build_payload(
        audio_path,
        model_name=model_name,
        device=device,
        compute_type=compute_type,
        language=language,
        batch_size=batch_size,
        vad_filter=vad_filter,
        min_silence_ms=min_silence_ms,
        word_timestamps=word_timestamps,
        vad_model=_vad_model_label(vad_model),
        info=info,
        segments=segments,
        vad_segments=vad_segments,
    )


def _render_txt_sidecar(segments: list[Segment], fallback_text: str) -> str:
    if segments:
        return "\n".join(seg.text for seg in segments).strip()
    return fallback_text.strip()


def render_sidecars(payload: dict[str, Any]) -> dict[str, str]:
    segments = extract_segments(payload, source="faster-whisper/oneoff")
    text = extract_transcript_text(payload)
    txt_text = _render_txt_sidecar(segments, fallback_text=text)
    return {
        "txt": (txt_text or "") + ("\n" if txt_text else ""),
        "srt": render_srt(segments),
        "vtt": render_vtt(segments),
    }


def write_json(payload: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_sidecars(
    payload: dict[str, Any],
    paths: OutputPaths,
    *,
    overwrite: bool,
) -> list[Path]:
    rendered = render_sidecars(payload)
    paths.json.parent.mkdir(parents=True, exist_ok=True)
    json_mtime = paths.json.stat().st_mtime if paths.json.exists() else 0.0
    written: list[Path] = []
    for key, target in (
        ("txt", paths.txt),
        ("srt", paths.srt),
        ("vtt", paths.vtt),
    ):
        if not overwrite and target.exists() and target.stat().st_mtime >= json_mtime:
            continue
        target.write_text(rendered[key], encoding="utf-8")
        written.append(target)
    return written


def _add_optional_value(args: list[str], flag: str, value: object | None) -> None:
    if value is not None:
        args.extend([flag, str(value)])


def _docker_script_args(args: argparse.Namespace, audio_files: list[Path]) -> list[str]:
    script_args: list[str] = [
        "--runtime",
        "host",
        "--suffix",
        args.suffix,
        "--device",
        args.device,
        "--compute-type",
        args.compute_type,
        "--batch-size",
        str(args.batch_size),
    ]
    _add_optional_value(script_args, "--language", args.language)
    _add_optional_value(
        script_args,
        "--output-dir",
        args.output_dir.expanduser().resolve() if args.output_dir else None,
    )
    _add_optional_value(script_args, "--model", args.model)
    _add_optional_value(script_args, "--vad-model", args.vad_model)
    _add_optional_value(script_args, "--min-silence-ms", args.min_silence_ms)

    if args.overwrite:
        script_args.append("--overwrite")
    if args.json_only:
        script_args.append("--json-only")
    if args.vad_filter is True:
        script_args.append("--vad-filter")
    elif args.vad_filter is False:
        script_args.append("--no-vad-filter")
    if args.word_timestamps is True:
        script_args.append("--word-timestamps")
    elif args.word_timestamps is False:
        script_args.append("--no-word-timestamps")
    if args.verbose:
        script_args.append("--verbose")

    script_args.extend(str(path) for path in audio_files)
    return script_args


def _docker_extra_env() -> tuple[bool, dict[str, str]]:
    from besedy.config.settings import resolve_config_path
    from besedy.lib.runtime.backend_runtime import forward_host_env
    from besedy.lib.runtime.docker_worker import DEFAULT_CONTAINER_CONFIG_PATH

    extra_env = {
        "PYTHONPATH": "/workspace/besedy",
        **forward_host_env("HF_TOKEN", "HUGGINGFACE_TOKEN"),
    }
    try:
        resolve_config_path()
    except FileNotFoundError:
        return False, extra_env

    extra_env["BESEDY_CONFIG"] = str(DEFAULT_CONTAINER_CONFIG_PATH)
    return True, extra_env


def run_in_faster_whisper_docker(
    args: argparse.Namespace,
    *,
    audio_files: list[Path],
    outputs: dict[Path, OutputPaths],
    model_name: str,
) -> int:
    from besedy.lib.runtime.backend_runtime import (
        build_command_backend_process,
        resolve_local_model_path,
    )

    include_config, extra_env = _docker_extra_env()
    input_paths: list[Path | str] = list(audio_files)
    output_paths: list[Path | str] = [outputs[audio_path].json for audio_path in audio_files]
    model_paths: list[Path | str] = []
    local_model_path = resolve_local_model_path(args.model or model_name)
    if local_model_path is not None:
        model_paths.append(local_model_path)

    process = build_command_backend_process(
        backend_id="faster-whisper",
        display_name="faster-whisper one-off transcription",
        docker_argv=[
            "python",
            "/workspace/besedy/besedy/cli/transcribe_oneoff.py",
            *_docker_script_args(args, audio_files),
        ],
        docker_service="faster-whisper",
        extra_env=extra_env,
        input_paths=input_paths,
        output_paths=output_paths,
        model_paths=model_paths,
        docker_gpus="all",
        include_project_root=True,
        include_config=include_config,
    )
    logging.info("Launching faster-whisper Docker backend.")
    completed = subprocess.run(process.argv, env=process.extra_env)
    return completed.returncode


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    try:
        audio_files = ensure_audio_files(args.audio)
        output_suffix = _normalize_suffix(args.suffix)
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    outputs = {
        audio_path: resolve_output_paths(
            audio_path,
            output_dir=args.output_dir,
            suffix=output_suffix,
        )
        for audio_path in audio_files
    }
    try:
        _assert_unique_outputs(outputs)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    try:
        defaults = resolve_defaults()
    except Exception as exc:
        print(f"Error: unable to load Besedy defaults: {exc}", file=sys.stderr)
        return 1

    model_name = args.model or defaults.model_name
    vad_model = args.vad_model if args.vad_model is not None else defaults.vad_model
    language_setting = resolve_language_setting(args.language, defaults.language)
    language = resolve_inference_language(language_setting)
    vad_filter = defaults.vad_filter if args.vad_filter is None else bool(args.vad_filter)
    word_timestamps = (
        defaults.word_timestamps if args.word_timestamps is None else bool(args.word_timestamps)
    )
    min_silence_ms = defaults.min_silence_ms if args.min_silence_ms is None else args.min_silence_ms

    pending: list[Path] = []
    for audio_path in audio_files:
        paths = outputs[audio_path]
        if paths.json.exists() and not args.overwrite:
            logging.info("Reusing existing transcript JSON: %s", paths.json)
            if not args.json_only:
                try:
                    payload = load_json_with_fallback(paths.json)
                    written = write_sidecars(payload, paths, overwrite=False)
                except Exception as exc:
                    print(
                        f"Error: unable to export sidecars for {paths.json}: {exc}", file=sys.stderr
                    )
                    return 1
                for sidecar in written:
                    logging.info("Wrote sidecar: %s", sidecar)
            continue
        pending.append(audio_path)

    if not pending:
        logging.info("No audio files require transcription.")
        return 0

    if args.runtime == "docker":
        try:
            return run_in_faster_whisper_docker(
                args,
                audio_files=pending,
                outputs=outputs,
                model_name=model_name,
            )
        except Exception as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1

    try:
        helpers = _load_faster_whisper_helpers()
        model_reference = helpers.resolve_model_reference(model_name)
        logging.info(
            "Loading faster-whisper model %s on %s (%s)",
            model_reference,
            args.device,
            args.compute_type,
        )
        model = helpers.WhisperModel(
            model_reference,
            device=args.device,
            compute_type=args.compute_type,
        )
        pipeline = helpers.BatchedInferencePipeline(model=model)

        for audio_path in pending:
            paths = outputs[audio_path]
            logging.info("Transcribing %s", audio_path)
            payload = transcribe_audio(
                audio_path,
                helpers=helpers,
                pipeline=pipeline,
                model_name=model_name,
                device=args.device,
                compute_type=args.compute_type,
                language=language,
                batch_size=args.batch_size,
                vad_filter=vad_filter,
                min_silence_ms=min_silence_ms,
                word_timestamps=word_timestamps,
                vad_model=vad_model,
            )
            write_json(payload, paths.json)
            logging.info("Wrote transcript JSON: %s", paths.json)
            if not args.json_only:
                for sidecar in write_sidecars(payload, paths, overwrite=True):
                    logging.info("Wrote sidecar: %s", sidecar)
    except MissingFasterWhisperRuntimeError as exc:
        if args.runtime == "auto":
            logging.info("%s", exc)
            try:
                return run_in_faster_whisper_docker(
                    args,
                    audio_files=pending,
                    outputs=outputs,
                    model_name=model_name,
                )
            except Exception as docker_exc:
                print(f"Error: {docker_exc}", file=sys.stderr)
                return 1
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
