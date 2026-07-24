#!/usr/bin/env python3
"""WhisperX wrapper that writes canonical transcript.json outputs."""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path
from typing import Any

from besedy.core.paths import (
    PROJECT_ROOT,
    require_valid_hash_stem,
    resolve_project_path,
    resolve_transcripts_root,
)
from besedy.lib.audio.probe import measure_audio_duration_seconds
from besedy.lib.data.atomic_io import atomic_write_text
from besedy.lib.data.whisperx_conversion import convert_whisperx
from besedy.lib.subprocess_utils import (
    install_signal_handlers,
    register_process,
    unregister_process,
)
from besedy.lib.workflow.config import select_transcription_workflow
from besedy.lib.workflow.language import (
    resolve_inference_language,
    resolve_language_setting,
    validate_workflow_language,
)
from besedy.lib.workflow.paths import sanitize_model_identifier

DEFAULT_COMPUTE_TYPE = "float16"
DEFAULT_BATCH_SIZE = 8


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcribe staged audio with WhisperX and write canonical transcript.json.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--audio",
        type=Path,
        nargs="+",
        required=True,
        help="One or more staged WAV paths (filename stem should be the SHA256 hash).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Root directory for whisperx transcripts (workflow root).",
    )
    parser.add_argument(
        "--keep-raw",
        action="store_true",
        help="Keep raw WhisperX JSON outputs in the _raw_whisperx directory.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Override WhisperX model identifier.",
    )
    parser.add_argument(
        "--vad-model",
        default=None,
        help="VAD model identifier for WhisperX (e.g., silero).",
    )
    parser.add_argument(
        "--align-model",
        default=None,
        help="Alignment model identifier for WhisperX.",
    )
    parser.add_argument(
        "--language",
        default=None,
        help=(
            "Language code forwarded to WhisperX. Use 'auto' to let WhisperX detect it; "
            "defaults to the configured workflow language."
        ),
    )
    return parser.parse_args()


def _resolve_audio_paths(paths: list[Path]) -> list[Path]:
    resolved: list[Path] = []
    for audio_path in paths:
        candidate = audio_path.expanduser().resolve()
        if not candidate.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        resolved.append(candidate)
    return resolved


def _resolve_bundle_root(
    output_dir: Path | None,
    *,
    workflow_label: str,
    output_component: str,
) -> Path:
    if output_dir is not None:
        workflow_root = resolve_project_path(output_dir)
    else:
        workflow_root = resolve_transcripts_root(None) / workflow_label
    bundle_root = workflow_root / output_component
    bundle_root.mkdir(parents=True, exist_ok=True)
    return bundle_root


def _resolve_whisperx_cli() -> str:
    override = os.getenv("BESEDY_WHISPERX_CLI")
    if override:
        resolved = shutil.which(override)
        if resolved:
            return resolved
        candidate = Path(override).expanduser()
        if candidate.exists():
            return str(candidate)
        raise RuntimeError(f"BESEDY_WHISPERX_CLI does not exist: {candidate}")

    resolved = shutil.which("whisperx")
    if resolved:
        return resolved

    raise RuntimeError(
        "WhisperX CLI not found. Set BESEDY_WHISPERX_CLI or make `whisperx` available on PATH. "
        "Normal Besedy runs use the Docker whisperx worker."
    )


def _run_whisperx(
    audio_paths: list[Path],
    raw_dir: Path,
    *,
    model: str,
    language: str | None,
    align_model: str | None,
    vad_method: str | None,
    compute_type: str,
    batch_size: int,
) -> int:
    cmd = [
        _resolve_whisperx_cli(),
        *(str(path) for path in audio_paths),
        "--model",
        model,
        "--output_dir",
        str(raw_dir),
        "--output_format",
        "json",
        "--compute_type",
        compute_type,
        "--batch_size",
        str(batch_size),
    ]
    if language:
        cmd.extend(["--language", language])
    if align_model:
        cmd.extend(["--align_model", align_model])
    if vad_method:
        cmd.extend(["--vad_method", vad_method])

    proc = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT))
    register_process(proc)
    try:
        return proc.wait()
    finally:
        unregister_process(proc)


MAX_CONSECUTIVE_RETRY_FAILURES = 3


def _retry_missing_outputs_individually(
    audio_paths: list[Path],
    raw_dir: Path,
    **run_kwargs,
) -> None:
    """Re-run files that produced no raw output one at a time.

    A batch invocation aborts on the first file WhisperX cannot process (for
    example an auto-detected language without a default alignment model), so a
    per-file retry confines the failure to the offending file instead of losing
    the rest of the batch. When the batch produced no output at all, the
    failure is likely systemic (OOM, bad model, missing credentials) and would
    repeat for every file, so the retry gives up after a few consecutive
    failures instead of paying a model load per staged file. Any produced
    output proves per-file retries can work and disarms that guard.
    """
    missing = [
        audio_path
        for audio_path in audio_paths
        if not (raw_dir / f"{require_valid_hash_stem(audio_path)}.json").exists()
    ]
    systemic_guard = len(missing) == len(audio_paths)
    consecutive_failures = 0
    for audio_path in missing:
        output_json = raw_dir / f"{require_valid_hash_stem(audio_path)}.json"
        exit_code = _run_whisperx([audio_path], raw_dir, **run_kwargs)
        if output_json.exists():
            systemic_guard = False
            consecutive_failures = 0
            continue
        logging.error(
            "WhisperX produced no output for %s (exit code %d)", audio_path.name, exit_code
        )
        consecutive_failures += 1
        if systemic_guard and consecutive_failures >= MAX_CONSECUTIVE_RETRY_FAILURES:
            logging.error(
                "Giving up on per-file retries after %d consecutive failures with no "
                "successful output; the batch failure looks systemic.",
                consecutive_failures,
            )
            return


def _convert_outputs(
    audio_paths: list[Path],
    raw_dir: Path,
    output_root: Path,
    keep_raw: bool,
    *,
    model: str,
    align_model: str | None,
    vad_method: str | None,
    compute_type: str,
    batch_size: int,
) -> int:
    failures = 0
    for audio_path in audio_paths:
        hash_component = require_valid_hash_stem(audio_path)
        output_json = raw_dir / f"{hash_component}.json"
        if not output_json.exists():
            logging.warning("Missing WhisperX output for %s", audio_path.name)
            failures += 1
            continue

        try:
            payload = json.loads(output_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            logging.warning("Invalid WhisperX JSON for %s: %s", audio_path.name, exc)
            failures += 1
            continue

        duration_seconds = measure_audio_duration_seconds(audio_path)
        output_dir = output_root / hash_component
        output_dir.mkdir(parents=True, exist_ok=True)

        converted = convert_whisperx(
            payload,
            backend="whisperx",
            model=model,
            duration_seconds=duration_seconds,
            audio_filepath=str(audio_path),
            align_model=align_model,
            vad_method=vad_method,
            compute_type=compute_type,
            batch_size=batch_size,
        )

        target_path = output_dir / "transcript.json"
        serialized = json.dumps(converted, ensure_ascii=False, indent=2)
        atomic_write_text(target_path, serialized, encoding="utf-8")
        logging.info("Converted %s -> %s", audio_path.name, target_path)

        if not keep_raw:
            try:
                output_json.unlink()
            except OSError:
                pass

    return failures


def main() -> int:
    install_signal_handlers()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()

    audio_paths = _resolve_audio_paths(args.audio)
    if not audio_paths:
        logging.info("No audio files provided; nothing to do.")
        return 0

    default_config = select_transcription_workflow(
        "whisperx",
        model_name=args.model,
        language=args.language,
    )
    model_name = args.model or default_config.model_name
    vad_model = args.vad_model or default_config.vad_model
    align_model = args.align_model or default_config.align_model
    language_setting = resolve_language_setting(args.language, default_config.language)
    language = resolve_inference_language(language_setting)
    # Same rule the config loader enforces; CLI overrides combined with an
    # inherited variant must not recreate the unsafe auto+aligner pairing.
    validate_workflow_language("whisperx", language_setting, align_model, context="this run:")
    workflow_config = replace(
        default_config,
        model_name=model_name,
        vad_model=vad_model,
        align_model=align_model,
        language=language_setting,
    )
    output_component = workflow_config.output_component(sanitize_model_identifier)
    output_root = _resolve_bundle_root(
        args.output_dir,
        workflow_label=default_config.workflow_label,
        output_component=output_component,
    )
    raw_dir = output_root / "_raw_whisperx"
    raw_dir.mkdir(parents=True, exist_ok=True)

    run_kwargs: dict[str, Any] = dict(
        model=model_name,
        language=language,
        align_model=align_model,
        vad_method=vad_model,
        compute_type=DEFAULT_COMPUTE_TYPE,
        batch_size=DEFAULT_BATCH_SIZE,
    )
    logging.info("Running WhisperX on %d file(s).", len(audio_paths))
    exit_code = _run_whisperx(audio_paths, raw_dir, **run_kwargs)
    if exit_code != 0:
        logging.warning(
            "WhisperX batch run exited with code %d; retrying files without output individually.",
            exit_code,
        )
        _retry_missing_outputs_individually(audio_paths, raw_dir, **run_kwargs)

    failures = _convert_outputs(
        audio_paths,
        raw_dir,
        output_root,
        args.keep_raw,
        model=model_name,
        align_model=align_model,
        vad_method=vad_model,
        compute_type=DEFAULT_COMPUTE_TYPE,
        batch_size=DEFAULT_BATCH_SIZE,
    )
    if failures:
        logging.error("WhisperX conversion had %d issue(s).", failures)
        return 1

    if not args.keep_raw:
        try:
            raw_dir.rmdir()
        except OSError:
            pass

    logging.info("WhisperX transcripts stored in %s", output_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
