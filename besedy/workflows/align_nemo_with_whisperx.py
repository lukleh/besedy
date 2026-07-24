#!/usr/bin/env python3
"""Align NeMo beam-decoded segments with WhisperX.

Besedy normally launches this script inside the Docker whisperx worker. Direct
host execution requires a WhisperX CLI to be available via BESEDY_WHISPERX_CLI
or PATH.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# This script may be executed directly, so it bootstraps the repo root onto
# sys.path before importing the package.
from besedy.core.paths import (  # noqa: E402
    resolve_config_home,
    resolve_project_path,
    resolve_transcripts_root,
)

DEFAULT_ALIGNED_OUTPUT_NAME = "nemo_beam_aligned.json"


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _extract_segments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    segments = payload.get("segments")
    if not isinstance(segments, list):
        raise ValueError("Expected 'segments' list in transcript JSON.")
    cleaned: list[dict[str, Any]] = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        text = (seg.get("text") or "").strip()
        start = seg.get("start")
        end = seg.get("end")
        if not text or start is None or end is None:
            continue
        cleaned.append({"start": float(start), "end": float(end), "text": text})
    return cleaned


def _resolve_audio_path(
    audio_override: Path | None,
    transcript_meta: dict[str, Any] | None,
    segments_meta: dict[str, Any] | None,
) -> Path:
    if audio_override is not None:
        return audio_override
    for meta in (segments_meta, transcript_meta):
        if not meta:
            continue
        audio = meta.get("audio_filepath")
        if audio:
            return Path(audio)
    raise ValueError("No audio path found in transcript/segments meta; pass --audio.")


def _find_config_path() -> Path | None:
    env_path = os.getenv("BESEDY_CONFIG")
    if env_path:
        candidate = Path(env_path).expanduser()
        return candidate if candidate.exists() else None

    candidates = [
        Path.cwd() / "besedy.toml",
        PROJECT_ROOT / "besedy.toml",
        resolve_config_home() / "besedy.toml",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _resolve_transcripts_from_text_root(text_root: Path) -> Path:
    transcripts_dir = text_root / "transcripts"
    inner_symlink = transcripts_dir / "transcripts"
    if inner_symlink.is_symlink():
        return inner_symlink.resolve()
    return transcripts_dir


def _fallback_transcripts_root() -> Path | None:
    env_value = os.getenv("BESEDY_TEXT_DATA_ROOT")
    if env_value:
        candidate = Path(env_value).expanduser()
        text_root = candidate if candidate.is_absolute() else PROJECT_ROOT / candidate
        return _resolve_transcripts_from_text_root(text_root)

    config_path = _find_config_path()
    if config_path:
        try:
            with config_path.open("rb") as handle:
                data = tomllib.load(handle)
        except Exception as exc:
            logging.debug("Failed to read config %s: %s", config_path, exc)
            return None
        paths_cfg = data.get("paths", {}) if isinstance(data, dict) else {}
        text_data_dir = paths_cfg.get("text_data_dir") if isinstance(paths_cfg, dict) else None

        if text_data_dir:
            candidate = Path(text_data_dir).expanduser()
            text_root = candidate if candidate.is_absolute() else PROJECT_ROOT / candidate
            return _resolve_transcripts_from_text_root(text_root)

    return None


def _default_transcripts_root() -> Path:
    try:
        return resolve_transcripts_root()
    except Exception as exc:
        logging.debug("resolve_transcripts_root failed: %s", exc)
    fallback = _fallback_transcripts_root()
    if fallback is not None:
        return fallback
    return resolve_project_path("transcripts")


def _prepend_pythonpath(prefix: Path, existing: str | None) -> str:
    prefix_str = str(prefix)
    if not existing:
        return prefix_str
    if existing.split(os.pathsep)[0] == prefix_str:
        return existing
    return f"{prefix_str}{os.pathsep}{existing}"


def _build_canonical_conversion_invocation(
    *,
    aligned_output: Path,
    audio_path: Path,
    backend: str,
    model_label: str,
    canonical_output: Path,
    align_model_name: str | None,
) -> tuple[list[str], dict[str, str]]:
    cmd = [
        sys.executable,
        "-m",
        "besedy.cli.convert_whisperx_transcript",
        str(aligned_output),
        "--audio",
        str(audio_path),
        "--backend",
        backend,
        "--model",
        model_label,
        "--output",
        str(canonical_output),
    ]
    if align_model_name:
        cmd.extend(["--align-model", align_model_name])

    env = os.environ.copy()
    env["PYTHONPATH"] = _prepend_pythonpath(PROJECT_ROOT, env.get("PYTHONPATH"))
    return cmd, env


def _iter_transcripts_runs(transcripts_root: Path, workflow: str) -> list[Path]:
    root = transcripts_root.expanduser().resolve()
    candidates: list[Path] = []

    if (root / workflow).is_dir():
        candidates.append(root)
        logging.debug("Found workflow dir at root: %s", root)

    inner_symlink = root / "transcripts"
    if inner_symlink.is_symlink():
        resolved = inner_symlink.resolve()
        if resolved.is_dir():
            candidates.append(resolved)
            logging.debug("Found inner transcripts symlink: %s -> %s", inner_symlink, resolved)

    for path in sorted(root.glob("transcripts_*")):
        if path.is_dir():
            candidates.append(path)
            logging.debug("Found transcripts run dir: %s", path)

    if not candidates:
        candidates.append(root)
        logging.debug("No run dirs found; using root: %s", root)

    seen: set[Path] = set()
    unique: list[Path] = []
    for path in candidates:
        resolved = path.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


def _find_transcript_dir(transcripts_root: Path, workflow: str, hash_value: str) -> Path:
    run_roots = _iter_transcripts_runs(transcripts_root, workflow)
    candidates: list[Path] = []
    for run_root in run_roots:
        workflow_dir = run_root / workflow
        if not workflow_dir.exists():
            continue
        matches = [path for path in workflow_dir.glob(f"*/{hash_value}") if path.is_dir()]
        candidates.extend(matches)
    if not candidates:
        searched = "\n".join(str(path) for path in run_roots)
        raise SystemExit(f"No transcript folder found for hash {hash_value} in:\n{searched}")
    if len(candidates) > 1:
        joined = "\n".join(str(path) for path in candidates)
        raise SystemExit(
            "Multiple transcript folders found; specify --transcript, --segments, or --segments-path:\n"
            + joined
        )
    return candidates[0]


def _collect_segments_paths(
    transcripts_root: Path,
    workflow: str,
    model_component: str | None = None,
) -> list[Path]:
    run_roots = _iter_transcripts_runs(transcripts_root, workflow)
    segments_paths: list[Path] = []
    for run_root in run_roots:
        workflow_dir = run_root / workflow
        if not workflow_dir.exists():
            continue
        model_dirs = (
            [workflow_dir / model_component]
            if model_component
            else sorted(path for path in workflow_dir.iterdir() if path.is_dir())
        )
        for model_dir in model_dirs:
            if not model_dir.exists() or not model_dir.is_dir():
                continue
            for hash_dir in sorted(path for path in model_dir.iterdir() if path.is_dir()):
                candidate = hash_dir / "nemo_beam_segments.json"
                if candidate.exists():
                    segments_paths.append(candidate)
    return segments_paths


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _sanitize_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        text = (seg.get("text") or "").strip()
        start = seg.get("start")
        end = seg.get("end")
        if not text or start is None or end is None:
            continue
        cleaned.append({"start": float(start), "end": float(end), "text": text})
    return cleaned


def _get_tqdm():
    try:
        from tqdm import tqdm

        return tqdm
    except Exception:
        return None


def _iter_with_progress(items: list[Path], *, label: str, enabled: bool):
    if not enabled:
        return items

    tqdm = _get_tqdm()
    if tqdm is not None:
        return tqdm(items, total=len(items), desc=label, unit="file")

    total = len(items)
    width = 28

    def _generator():
        for idx, item in enumerate(items, start=1):
            filled = int(width * idx / total) if total else width
            bar = "=" * filled + "-" * (width - filled)
            sys.stderr.write(f"\r{label}: [{bar}] {idx}/{total}")
            sys.stderr.flush()
            yield item
        if total:
            sys.stderr.write("\n")
            sys.stderr.flush()

    return _generator()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Align NeMo beam-decoded segments with WhisperX (PoC)."
    )
    parser.add_argument(
        "--transcript",
        type=Path,
        default=None,
        help="Path to the NeMo transcript.json (canonical schema).",
    )
    parser.add_argument(
        "--hash",
        default=None,
        help="Audio hash prefix to locate transcripts/ folder automatically.",
    )
    parser.add_argument(
        "--transcripts-root",
        type=Path,
        default=None,
        help="Transcripts directory (container or timestamped root). Default: resolve from config.",
    )
    parser.add_argument(
        "--workflow",
        default="canary-nemo",
        help="Workflow folder under transcripts root (default: canary-nemo).",
    )
    parser.add_argument(
        "--scan",
        action="store_true",
        help="Scan workflow folder and align all nemo_beam_segments.json files.",
    )
    parser.add_argument(
        "--segments",
        type=Path,
        nargs="+",
        default=None,
        help="Explicit list of nemo_beam_segments.json files to align.",
    )
    parser.add_argument(
        "--audio",
        type=Path,
        default=None,
        help="Path to the WAV file (overrides meta.audio_filepath).",
    )
    parser.add_argument(
        "--language",
        default="cs",
        help="Language code for alignment (default: cs).",
    )
    parser.add_argument(
        "--align-model",
        default=None,
        help="Alignment model name (WhisperX default for language if omitted).",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=("auto", "cpu", "cuda"),
        help="Device for alignment model.",
    )
    parser.add_argument(
        "--interpolate-method",
        default="nearest",
        choices=("nearest", "linear", "ignore"),
        help="Interpolation method for unaligned words.",
    )
    parser.add_argument(
        "--return-char-alignments",
        action="store_true",
        help="Include character-level alignments in output.",
    )
    parser.add_argument(
        "--no-progress",
        action="store_true",
        help="Disable progress bars for files and alignment.",
    )
    parser.add_argument(
        "--segments-path",
        type=Path,
        default=None,
        help="Optional path for nemo_beam_segments.json (defaults to transcript folder).",
    )
    parser.add_argument(
        "--aligned-output",
        type=Path,
        default=None,
        help="Optional path for aligned JSON (defaults to transcript folder).",
    )
    parser.add_argument(
        "--model-component",
        default=None,
        help="Limit --scan to a specific model component directory.",
    )
    parser.add_argument(
        "--no-convert",
        action="store_true",
        help="Skip canonical transcript conversion.",
    )
    parser.add_argument(
        "--canonical-output",
        type=Path,
        default=None,
        help="Path for canonical transcript output (default: transcript.json).",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip alignment when output already exists (useful with --scan).",
    )
    parser.add_argument(
        "--backend",
        default="canary-nemo-beam",
        help="Backend label for canonical transcript conversion.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Model label for canonical transcript conversion.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable verbose debug logging.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    if args.segments and args.scan:
        raise SystemExit("--segments cannot be used with --scan.")
    if args.segments and (args.transcript is not None or args.hash is not None):
        raise SystemExit("--segments cannot be combined with --transcript or --hash.")
    if args.segments and args.segments_path is not None:
        raise SystemExit("--segments cannot be combined with --segments-path.")
    if args.segments and args.audio is not None:
        raise SystemExit("--audio cannot be used with --segments.")
    if args.scan and args.audio is not None:
        raise SystemExit("--audio cannot be used with --scan.")

    def _resolve_segments_paths(paths: list[Path]) -> list[Path]:
        resolved: list[Path] = []
        seen: set[Path] = set()
        for path in paths:
            candidate = path.expanduser().resolve()
            if candidate in seen:
                continue
            seen.add(candidate)
            resolved.append(candidate)
        missing = [path for path in resolved if not path.exists()]
        for path in missing:
            logging.warning("Segments file not found: %s", path)
        resolved = [path for path in resolved if path.exists() and path.is_file()]
        if not resolved:
            raise SystemExit("No nemo_beam_segments.json files found to align.")
        return resolved

    segments_paths: list[Path] = []
    transcripts_root: Path | None = None

    if args.segments:
        segments_paths = _resolve_segments_paths(args.segments)
    else:
        if args.transcripts_root is None:
            transcripts_root = _default_transcripts_root()
        else:
            transcripts_root = resolve_project_path(args.transcripts_root.expanduser())
        logging.debug("Resolved transcripts root: %s", transcripts_root)

        if args.scan:
            segments_paths = _collect_segments_paths(
                transcripts_root, args.workflow, args.model_component
            )
            logging.debug("Segments discovered: %d", len(segments_paths))
            for path in segments_paths:
                logging.debug("Segment: %s", path)
            if not segments_paths:
                raise SystemExit("No nemo_beam_segments.json files found to align.")

    transcript_path: Path | None = None
    transcript_payload: dict[str, Any] | None = None
    transcript_meta: dict[str, Any] | None = None

    def run_alignment(
        *,
        segments_path: Path | None,
        output_dir: Path,
        transcript_path: Path | None,
    ) -> bool:
        nonlocal transcript_payload, transcript_meta

        transcript_payload = None
        transcript_meta = None
        if transcript_path and transcript_path.exists():
            transcript_payload = _load_json(transcript_path)
            transcript_meta = transcript_payload.get("meta") or {}

        segments_meta: dict[str, Any] | None = None
        segments: list[dict[str, Any]] = []

        if segments_path and segments_path.exists():
            segments_payload = _load_json(segments_path)
            segments_meta = segments_payload.get("meta") or {}
            segments = segments_payload.get("segments") or []
            if not isinstance(segments, list):
                logging.warning("Invalid segments payload in %s", segments_path)
                return False
            original_count = len(segments)
            segments = _sanitize_segments(segments)
            dropped = original_count - len(segments)
            if dropped > 0:
                logging.debug("Skipped %d empty/invalid segments in %s", dropped, segments_path)
            if not segments:
                logging.warning("No segments found in %s", segments_path)
                return False
        else:
            if transcript_payload is None:
                logging.warning("Segments file missing; provide --transcript to build it.")
                return False
            raw_segments = transcript_payload.get("segments")
            original_count = len(raw_segments) if isinstance(raw_segments, list) else None
            segments = _extract_segments(transcript_payload)
            if original_count is not None:
                dropped = original_count - len(segments)
                if dropped > 0:
                    logging.debug(
                        "Skipped %d empty/invalid segments in %s",
                        dropped,
                        transcript_path or output_dir,
                    )
            if not segments:
                logging.warning("No usable segments found in %s", transcript_path)
                return False

            segments_path = output_dir / "nemo_beam_segments.json"
            _write_json(
                segments_path,
                {
                    "language": args.language,
                    "segments": segments,
                    "meta": {
                        "source_transcript": str(transcript_path) if transcript_path else None,
                        "audio_filepath": (
                            str(transcript_meta.get("audio_filepath"))
                            if transcript_meta and transcript_meta.get("audio_filepath")
                            else None
                        ),
                    },
                },
            )
            logging.info("Saved segments: %s", segments_path)

        audio_path = _resolve_audio_path(args.audio, transcript_meta, segments_meta)
        if not audio_path.exists():
            logging.warning("Audio file not found: %s", audio_path)
            return False

        aligned_output = args.aligned_output or output_dir / DEFAULT_ALIGNED_OUTPUT_NAME
        canonical_output = args.canonical_output or output_dir / "transcript.json"

        if args.skip_existing:
            if not args.no_convert and canonical_output.exists():
                logging.info("Skipping alignment; output exists: %s", canonical_output)
                return True
            if args.no_convert and aligned_output.exists():
                logging.info("Skipping alignment; output exists: %s", aligned_output)
                return True

        aligned = whisperx.align(
            segments,
            align_model,
            align_meta,
            str(audio_path),
            device,
            interpolate_method=args.interpolate_method,
            return_char_alignments=args.return_char_alignments,
            print_progress=not args.no_progress,
        )

        aligned_payload = {
            "language": args.language,
            "segments": aligned.get("segments", []),
            "word_segments": aligned.get("word_segments", []),
        }
        _write_json(aligned_output, aligned_payload)
        logging.info("Saved aligned output: %s", aligned_output)

        if args.no_convert:
            return True

        backend = args.backend
        model_label = (
            args.model
            or (transcript_meta.get("model") if transcript_meta else None)
            or (segments_meta.get("model") if segments_meta else None)
            or "canary-nemo-beam"
        )
        align_model_name = args.align_model

        cmd, env = _build_canonical_conversion_invocation(
            aligned_output=aligned_output,
            audio_path=audio_path,
            backend=backend,
            model_label=model_label,
            canonical_output=canonical_output,
            align_model_name=align_model_name,
        )
        try:
            subprocess.run(cmd, check=True, cwd=str(PROJECT_ROOT), env=env)
            logging.info("Saved canonical transcript: %s", canonical_output)
            return True
        except subprocess.CalledProcessError as exc:
            logging.warning("Canonical conversion failed (exit %s).", exc.returncode)
            return False

    try:
        import torch
        import whisperx
    except Exception as exc:
        raise SystemExit(
            "WhisperX is not available in this environment. "
            "Run via external/whisperx-env/.venv/bin/python."
        ) from exc

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"

    align_model, align_meta = whisperx.load_align_model(
        args.language, device=device, model_name=args.align_model
    )

    failures: list[Path] = []

    if args.segments:
        for segments_path in _iter_with_progress(
            segments_paths, label="Files", enabled=not args.no_progress
        ):
            output_dir = segments_path.parent
            transcript_candidate = output_dir / "transcript.json"
            success = run_alignment(
                segments_path=segments_path,
                output_dir=output_dir,
                transcript_path=transcript_candidate if transcript_candidate.exists() else None,
            )
            if not success:
                failures.append(segments_path)
        if failures:
            raise SystemExit("Alignment failed for: " + ", ".join(str(path) for path in failures))
        return

    if args.scan:
        for segments_path in _iter_with_progress(
            segments_paths, label="Files", enabled=not args.no_progress
        ):
            output_dir = segments_path.parent
            transcript_candidate = output_dir / "transcript.json"
            success = run_alignment(
                segments_path=segments_path,
                output_dir=output_dir,
                transcript_path=transcript_candidate if transcript_candidate.exists() else None,
            )
            if not success:
                failures.append(segments_path)
        if failures:
            raise SystemExit("Alignment failed for: " + ", ".join(str(path) for path in failures))
        return

    if args.transcript is not None:
        transcript_path = args.transcript.expanduser().resolve()
        if not transcript_path.is_file():
            raise SystemExit(f"Transcript not found: {transcript_path}")
    elif args.hash:
        if transcripts_root is None:
            raise SystemExit("Unable to resolve transcripts root.")
        transcript_dir = _find_transcript_dir(transcripts_root, args.workflow, args.hash)
        candidate = transcript_dir / "transcript.json"
        if candidate.exists():
            transcript_path = candidate
    else:
        raise SystemExit("Provide --transcript or --hash to locate a transcript folder.")

    output_dir = transcript_path.parent if transcript_path else None
    if output_dir is None and args.hash:
        if transcripts_root is None:
            raise SystemExit("Unable to resolve transcripts root.")
        output_dir = _find_transcript_dir(transcripts_root, args.workflow, args.hash)
    if output_dir is None:
        raise SystemExit("Unable to resolve transcript output directory.")

    segments_path = args.segments_path or output_dir / "nemo_beam_segments.json"
    for segments_path in _iter_with_progress(
        [segments_path], label="Files", enabled=not args.no_progress
    ):
        success = run_alignment(
            segments_path=segments_path if segments_path.exists() else None,
            output_dir=output_dir,
            transcript_path=transcript_path,
        )
        if not success:
            failures.append(segments_path)

    if failures:
        raise SystemExit("Alignment failed for: " + ", ".join(str(path) for path in failures))


if __name__ == "__main__":
    main()
