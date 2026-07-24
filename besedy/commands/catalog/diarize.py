"""Diarization workflow command."""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

from besedy.commands.catalog.default_paths import ALREADY_EXISTS_REASON
from besedy.commands.catalog.ui import has_error_skips, print_workflow_summary
from besedy.commands.catalog.validation import (
    print_validation_errors,
    validate_staged_audio,
)
from besedy.commands.catalog.workflow_setup import (
    extract_run_info,
    prepare_workflow_env,
    resolve_and_load_catalog,
    setup_output_root,
)
from besedy.core.paths import hash_component_from_sha
from besedy.lib.audio.types import SkippedEntry
from besedy.lib.workflow.common import CsvAudioRow
from besedy.lib.workflow.runner import (
    WorkflowRunConfig,
    artifact_exists,
    build_workflows,
    launch_workflows,
    resolve_output_root,
)


@dataclass
class DiarizeRequest:
    csv: Path | None = None
    output_root: Path | None = None
    no_symlink: bool = False
    overwrite: bool = False
    continue_on_error: bool = False
    limit: int | None = None
    workflows: list[str] | None = None
    pyannote_parallel: int | None = None
    pyannote_min_speakers: int | None = None
    pyannote_max_speakers: int | None = None
    pyannote_clustering_threshold: float | None = None

    @classmethod
    def from_args(
        cls,
        args: argparse.Namespace | "DiarizeRequest",
    ) -> "DiarizeRequest":
        if isinstance(args, cls):
            return args
        workflows = getattr(args, "workflows", None)
        return cls(
            csv=getattr(args, "csv", None),
            output_root=getattr(args, "output_root", None),
            no_symlink=bool(getattr(args, "no_symlink", False)),
            overwrite=bool(getattr(args, "overwrite", False)),
            continue_on_error=bool(getattr(args, "continue_on_error", False)),
            limit=getattr(args, "limit", None),
            workflows=list(workflows) if workflows is not None else None,
            pyannote_parallel=getattr(args, "pyannote_parallel", None),
            pyannote_min_speakers=getattr(args, "pyannote_min_speakers", None),
            pyannote_max_speakers=getattr(args, "pyannote_max_speakers", None),
            pyannote_clustering_threshold=getattr(args, "pyannote_clustering_threshold", None),
        )


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'diarize' subparser."""
    from besedy.commands.catalog.system import parse_positive_int
    from besedy.lib.backend_ids import DIARIZATION_WORKFLOW_IDS

    parser = subparsers.add_parser(
        "diarize",
        help="Identify and label speakers in audio (speaker diarization)",
        description="""\
Detects speaker changes and assigns labels (SPEAKER_01, SPEAKER_02, etc.) to
each speech segment. Does NOT identify who the speaker is, just that they're
different from other speakers in the same file.

Run `catalog cluster-speakers` separately to match speakers across recordings.

Backend:
  pyannote     State-of-the-art accuracy, requires HuggingFace token and GPU runtime

Example:
  catalog diarize --workflow pyannote
  catalog diarize --pyannote-max-speakers 3  # Hint: at most 3 speakers
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Staged catalog CSV (output of stage-audio). Default: audio_catalog_normalized.csv symlink.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=None,
        help="Root directory for speaker output. Default: transcripts_<timestamp>/ with transcripts/ symlink.",
    )
    parser.add_argument(
        "--no-symlink",
        action="store_true",
        help="Do not create or update the transcripts symlink.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing diarization outputs instead of skipping them.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continue processing remaining files if a workflow fails on some files.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help=(
            "Process up to N files that are missing diarization outputs. "
            "Useful for testing or processing in batches."
        ),
    )
    parser.add_argument(
        "--workflow",
        choices=DIARIZATION_WORKFLOW_IDS,
        action="append",
        dest="workflows",
        help="Diarization backend to use. Default: pyannote.",
    )
    parser.add_argument(
        "--pyannote-parallel",
        type=parse_positive_int,
        default=None,
        help="Parallel pyannote processes. Limited by GPU memory.",
    )
    parser.add_argument(
        "--pyannote-min-speakers",
        type=int,
        default=None,
        help="Hint to pyannote: minimum expected speakers. Helps when you know the recording format.",
    )
    parser.add_argument(
        "--pyannote-max-speakers",
        type=int,
        default=None,
        help="Hint to pyannote: maximum expected speakers. Prevents over-segmentation in noisy audio.",
    )
    parser.add_argument(
        "--pyannote-clustering-threshold",
        type=float,
        default=None,
        help="Within-recording diarization clustering sensitivity (0-2). Lower = more speakers detected. Default varies by model.",
    )
    parser.set_defaults(func=handle_diarize)
    return parser


def handle_diarize(
    args: argparse.Namespace | DiarizeRequest,
) -> int:
    """Run diarization workflow (Pyannote)."""
    request = DiarizeRequest.from_args(args)
    missing_limit = request.limit
    # Load all rows so --limit can be applied after checking which entries are missing.
    result = resolve_and_load_catalog(request.csv, "diarize", None)
    if result is None:
        return 0
    csv_path, rows = result

    run_id, base_name = extract_run_info(csv_path)

    if not setup_output_root(request, csv_path, run_id, base_name):
        return 1
    if request.output_root is None:
        print("Error: diarize output root was not resolved.", file=sys.stderr)
        return 1

    selection = set(request.workflows) if request.workflows else {"pyannote"}
    if "pyannote" not in selection:
        print("Error: pyannote is the only available diarization workflow.", file=sys.stderr)
        return 1

    output_root = resolve_output_root(request.output_root)
    hashes_for_pyannote: set[str] = set()
    filtered_rows: list[CsvAudioRow] = []
    pre_skipped: list[SkippedEntry] = []
    candidates: list[tuple[CsvAudioRow, str]] = []

    for row in rows:
        hash_component = hash_component_from_sha(row.sha256)
        need_pyannote = request.overwrite or not artifact_exists(
            "pyannote", output_root, hash_component
        )

        if need_pyannote:
            candidates.append((row, hash_component))
        elif missing_limit is None:
            pre_skipped.append(
                SkippedEntry(row.sha256, Path(row.full_path).expanduser(), ALREADY_EXISTS_REASON)
            )

    if missing_limit is not None:
        candidates = candidates[:missing_limit]

    for row, hash_component in candidates:
        hashes_for_pyannote.add(hash_component)
        filtered_rows.append(row)

    if not filtered_rows:
        print("No audio files require diarization.")
        print_workflow_summary([], pre_skipped, [])
        return 1 if has_error_skips(pre_skipped) else 0

    prepared, validation_errors = validate_staged_audio(filtered_rows)
    skipped_total = list(pre_skipped)
    if validation_errors:
        if not request.continue_on_error:
            print_validation_errors(validation_errors, "diarize")
            return 1
        skipped_total.extend(
            SkippedEntry(sha, path, reason) for sha, path, reason in validation_errors
        )

    if not prepared:
        print("No staged audio files passed validation; nothing to do.")
        print_workflow_summary(prepared, skipped_total, [])
        return 1 if has_error_skips(skipped_total) else 0

    workflow_config = WorkflowRunConfig(
        output_root=output_root,
        enable_pyannote_diarization=True,
        pyannote_parallel=request.pyannote_parallel,
        pyannote_min_speakers=request.pyannote_min_speakers,
        pyannote_max_speakers=request.pyannote_max_speakers,
        pyannote_clustering_threshold=request.pyannote_clustering_threshold,
    )

    workflows = build_workflows(
        prepared,
        workflow_config,
        transcription_jobs=[],
        hashes_for_pyannote_diarization=hashes_for_pyannote,
    )

    if not workflows:
        print("No workflows to run.")
        print_workflow_summary(prepared, skipped_total, [])
        return 1 if has_error_skips(skipped_total) else 0

    base_env = prepare_workflow_env()
    failures = launch_workflows(workflows, base_env)

    print_workflow_summary(prepared, skipped_total, failures)
    return 0 if not failures and not has_error_skips(skipped_total) else 1
