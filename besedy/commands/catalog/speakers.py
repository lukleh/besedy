"""Speaker clustering command."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from besedy.commands.catalog.symlink import (
    create_or_update_symlink,
    validate_symlink_can_be_created,
)
from besedy.core.paths import (
    PROJECT_ROOT,
    PYANNOTE_DIARIZATION_MODEL_NAME,
    PYANNOTE_DIARIZATION_WORKFLOW_LABEL,
    assert_catalog_transcripts_alignment,
    extract_run_id_from_transcripts_root,
    require_run_id_from_transcripts_root,
    resolve_catalogs_root,
    resolve_transcripts_parent,
    resolve_transcripts_root,
)
from besedy.lib.runtime.backend_runtime import build_python_backend_process, forward_host_env
from besedy.lib.speakers.utils import load_diarization_json


@dataclass
class ClusterSpeakersRequest:
    cpu: bool = False
    model: str | None = None
    input_dir: Path | None = None
    cluster_distance: float | None = None
    min_duration: float | None = None
    embedding_cache_mode: str | None = None
    embedding_cache_dir: Path | None = None
    refresh_embedding_cache: bool = False
    output: Path | None = None
    no_symlink: bool = False
    hashes: list[str] = field(default_factory=list)

    @classmethod
    def from_args(
        cls,
        args: argparse.Namespace | "ClusterSpeakersRequest",
    ) -> "ClusterSpeakersRequest":
        if isinstance(args, cls):
            return args
        return cls(
            cpu=bool(getattr(args, "cpu", False)),
            model=getattr(args, "model", None),
            input_dir=getattr(args, "input_dir", None),
            cluster_distance=getattr(args, "cluster_distance", None),
            min_duration=getattr(args, "min_duration", None),
            embedding_cache_mode=getattr(args, "embedding_cache_mode", None),
            embedding_cache_dir=getattr(args, "embedding_cache_dir", None),
            refresh_embedding_cache=bool(getattr(args, "refresh_embedding_cache", False)),
            output=getattr(args, "output", None),
            no_symlink=bool(getattr(args, "no_symlink", False)),
            hashes=list(getattr(args, "hashes", [])),
        )


def _infer_transcripts_root_from_input_dir(input_dir: Path) -> Path | None:
    """Infer transcripts run root from an --input-dir pointing inside transcripts.

    Expected structure is:
      <transcripts_root>/<diarization_workflow>/<model>/
    """
    expanded = input_dir.expanduser()
    try:
        resolved = expanded.resolve()
    except OSError:
        resolved = expanded

    for candidate in (resolved, *resolved.parents):
        if extract_run_id_from_transcripts_root(candidate) is not None:
            return candidate
    return None


def _resolve_speakers_json_inputs(input_dir: Path, hashes: list[str]) -> list[Path]:
    resolved_input_dir = input_dir.expanduser().resolve()
    json_paths: list[Path] = []
    seen: set[Path] = set()

    def append_json(path: Path) -> None:
        try:
            candidate = path.expanduser().resolve()
        except OSError:
            candidate = path.expanduser()
        if candidate in seen:
            return
        seen.add(candidate)
        json_paths.append(candidate)

    if not hashes:
        for json_path in sorted(resolved_input_dir.glob("*/speakers.json")):
            append_json(json_path)
        return json_paths

    for raw in hashes:
        expanded = Path(raw).expanduser()
        if expanded.exists():
            resolved = expanded.resolve()
            if resolved.is_file() and resolved.name == "speakers.json":
                append_json(resolved)
                continue
            if resolved.is_dir():
                candidate = resolved / "speakers.json"
                if candidate.exists():
                    append_json(candidate)
                continue

        exact = resolved_input_dir / raw / "speakers.json"
        if exact.exists():
            append_json(exact)
            continue

        matches = sorted(resolved_input_dir.glob(f"{raw}*/speakers.json"))
        if matches:
            append_json(matches[0])

    return json_paths


def _resolve_speaker_audio_inputs(input_dir: Path, hashes: list[str]) -> list[Path]:
    audio_inputs: list[Path] = []
    seen: set[Path] = set()

    for json_path in _resolve_speakers_json_inputs(input_dir, hashes):
        try:
            diarization_data = load_diarization_json(json_path)
        except Exception:
            continue
        audio_file = diarization_data.get("audio_file")
        if not isinstance(audio_file, str) or not audio_file:
            continue
        candidate = Path(audio_file).expanduser()
        try:
            resolved = candidate.resolve() if candidate.exists() else candidate
        except OSError:
            resolved = candidate
        if resolved in seen:
            continue
        seen.add(resolved)
        audio_inputs.append(resolved)

    return audio_inputs


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'cluster-speakers' subparser."""
    parser = subparsers.add_parser(
        "cluster-speakers",
        help="Match speakers across multiple recordings using voice similarity",
        description="""\
Extracts voice embeddings (numerical representations of voice characteristics)
and clusters similar voices together. Identifies when the same person speaks
in different recordings, assigning consistent cross-file speaker IDs.

Note: Speaker IDs within a single file (SPEAKER_01, etc.) are assigned by
diarization. This command links speakers ACROSS files.

Example:
  catalog cluster-speakers                          # All files
  catalog cluster-speakers abc123 def456            # Specific hashes
  catalog cluster-speakers --cluster-distance 0.25  # Stricter matching

This catalog command uses the pyannote GPU worker in Besedy.
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--model",
        choices=["pyannote"],
        default=None,
        help="Voice embedding model for speaker clustering. Default: pyannote (GPU-required in catalog CLI).",
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=None,
        help="Directory containing speakers.json files. Default: auto-detect based on model.",
    )
    parser.add_argument(
        "--cluster-distance",
        type=float,
        default=None,
        help="Maximum voice embedding distance for matching (0-1). Lower = stricter matching, fewer false positives. Higher = more matches, may group different speakers. Default: 0.35.",
    )
    parser.add_argument(
        "--min-duration",
        type=float,
        default=None,
        help="Minimum speech segment length to use for embedding. Short segments produce unreliable embeddings. Default: 1.0 seconds.",
    )
    parser.add_argument(
        "--embedding-cache-mode",
        choices=["none", "file", "segment"],
        default=None,
        help="Embedding caching strategy. 'file': one embedding per file (fastest). 'segment': per speech segment (most accurate). 'none': no caching (slowest). Default: file.",
    )
    parser.add_argument(
        "--embedding-cache-dir",
        type=Path,
        default=None,
        help="Directory for cached embeddings. Default: transcripts/speaker_embeddings.",
    )
    parser.add_argument(
        "--refresh-embedding-cache",
        action="store_true",
        help="Recompute embeddings even if cached. Use after changing min-duration or fixing audio issues.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output JSON file. Default: speaker_clusters_<timestamp>/clusters_<model>.json with symlink.",
    )
    parser.add_argument(
        "--no-symlink",
        action="store_true",
        help="Do not create or update the speaker_clusters symlink.",
    )
    parser.add_argument(
        "hashes",
        nargs="*",
        help="Specific file hashes or paths to process. If omitted, processes all available speakers.json files.",
    )
    parser.set_defaults(func=handle_cluster_speakers)
    return parser


def handle_cluster_speakers(
    args: argparse.Namespace | ClusterSpeakersRequest,
) -> int:
    """Cluster speakers across files using hierarchical clustering of embeddings."""
    request = ClusterSpeakersRequest.from_args(args)
    script_path = PROJECT_ROOT / "besedy" / "core" / "cluster_speakers.py"
    no_symlink = request.no_symlink

    if not script_path.exists():
        print(f"Error: Script not found: {script_path}", file=sys.stderr)
        return 1

    # Determine output directory with timestamp matching
    output_file = request.output
    output_dir_for_symlink = None

    if output_file is None:
        catalogs_root = resolve_catalogs_root()
        transcripts_parent = resolve_transcripts_parent()
        transcripts_default = resolve_transcripts_root()
        # Determine transcripts root for timestamped output naming
        if request.input_dir:
            transcripts_root = _infer_transcripts_root_from_input_dir(request.input_dir)
            if transcripts_root is None:
                print(
                    "Error: Unable to infer transcripts run id from --input-dir. "
                    "Provide --output or point --input-dir inside "
                    "transcripts_<YYYYMMDD_HHMMSS>[_<variant>] or "
                    "transcripts_enhanced_<YYYYMMDD_HHMMSS>_<variant>.",
                    file=sys.stderr,
                )
                return 1
        else:
            transcripts_root = transcripts_default
            if transcripts_root.is_symlink():
                transcripts_root = transcripts_root.resolve()

        try:
            run_id = require_run_id_from_transcripts_root(transcripts_root)
            if request.input_dir is None:
                catalog_symlink = catalogs_root / "audio_catalog.csv"
                normalized_symlink = catalogs_root / "audio_catalog_normalized.csv"
                if catalog_symlink.exists() and normalized_symlink.exists():
                    assert_catalog_transcripts_alignment(
                        catalog_symlink.resolve(),
                        normalized_symlink.resolve(),
                        transcripts_root,
                    )
        except RuntimeError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1

        # Create timestamped output directory
        output_dir = transcripts_parent / f"speaker_clusters_{run_id}"
        output_dir_for_symlink = output_dir

        # Pre-flight validation: check if symlink can be created before doing clustering work
        symlink_path = transcripts_parent / "speaker_clusters"
        if not no_symlink:
            try:
                validate_symlink_can_be_created(symlink_path, description="speaker_clusters")
            except RuntimeError as e:
                print(f"Error: {e}", file=sys.stderr)
                return 1

        output_dir.mkdir(parents=True, exist_ok=True)

        # Generate output file path
        model_suffix = request.model if request.model else "pyannote"
        output_file = output_dir / f"clusters_{model_suffix}.json"
    else:
        output_file = output_file.expanduser()
        if not output_file.is_absolute():
            output_file = (Path.cwd() / output_file).resolve()

    # Create/update symlink if we created a timestamped directory
    if output_dir_for_symlink is not None and not no_symlink:
        symlink_path = transcripts_parent / "speaker_clusters"
        create_or_update_symlink(
            symlink_path, output_dir_for_symlink, description="speaker_clusters"
        )

    cmd: list[str] = []
    force_cpu = request.cpu

    if force_cpu:
        cmd.append("--cpu")

    if request.model:
        cmd.extend(["--model", request.model])

    if request.input_dir:
        cmd.extend(["--input-dir", str(request.input_dir.expanduser().resolve())])

    if request.cluster_distance is not None:
        cmd.extend(["--cluster-distance", str(request.cluster_distance)])

    if request.min_duration is not None:
        cmd.extend(["--min-duration", str(request.min_duration)])

    if request.embedding_cache_mode:
        cmd.extend(["--embedding-cache-mode", request.embedding_cache_mode])

    if request.embedding_cache_dir:
        embedding_cache_dir = request.embedding_cache_dir.expanduser()
        if not embedding_cache_dir.is_absolute():
            embedding_cache_dir = (Path.cwd() / embedding_cache_dir).resolve()
    else:
        embedding_cache_dir = resolve_transcripts_parent() / "speaker_embeddings"
    cmd.extend(["--embedding-cache-dir", str(embedding_cache_dir)])

    if request.refresh_embedding_cache:
        cmd.append("--refresh-embedding-cache")

    cmd.extend(["--output", str(output_file)])

    if request.hashes:
        cmd.extend(request.hashes)

    hash_path_inputs = [
        Path(arg).expanduser().resolve()
        for arg in request.hashes
        if Path(arg).expanduser().exists()
    ]
    default_input_dir = (
        resolve_transcripts_parent()
        / "transcripts"
        / PYANNOTE_DIARIZATION_WORKFLOW_LABEL
        / PYANNOTE_DIARIZATION_MODEL_NAME
    )
    speaker_input_dir = (
        request.input_dir.expanduser().resolve() if request.input_dir else default_input_dir
    )
    speaker_audio_inputs = _resolve_speaker_audio_inputs(speaker_input_dir, request.hashes)

    try:
        pyannote_extra_env = {
            "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD": "1",
            **forward_host_env("HF_TOKEN", "HUGGINGFACE_TOKEN"),
        }
        process = build_python_backend_process(
            backend_id="pyannote",
            display_name="pyannote-audio",
            script_path=script_path,
            script_args=cmd,
            docker_service="pyannote",
            extra_env=pyannote_extra_env or None,
            input_paths=[speaker_input_dir, *hash_path_inputs, *speaker_audio_inputs],
            output_paths=[output_file.parent],
            model_paths=[],
            temp_paths=[],
            cache_paths=[embedding_cache_dir],
            docker_gpus=None if force_cpu else "all",
        )
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    env = os.environ.copy()
    if process.extra_env:
        env.update(process.extra_env)
    try:
        result = subprocess.run(process.argv, env=env, cwd=str(PROJECT_ROOT), check=False)
        return result.returncode
    except Exception as exc:
        print(f"Error executing script: {exc}", file=sys.stderr)
        return 1
