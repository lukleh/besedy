"""Transcription workflow command."""

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
from besedy.core.paths import SHA256_HASH_PATTERN, hash_component_from_sha
from besedy.lib.audio.types import SkippedEntry
from besedy.lib.workflow.common import CsvAudioRow
from besedy.lib.workflow.config import (
    WorkflowConfig,
    get_transcription_workflows,
    matches_language,
)
from besedy.lib.workflow.paths import path_builder
from besedy.lib.workflow.runner import (
    TranscriptionJob,
    WorkflowRunConfig,
    build_workflows,
    launch_workflows,
    resolve_output_root,
)


@dataclass
class TranscribeRequest:
    csv: Path | None = None
    output_root: Path | None = None
    no_symlink: bool = False
    overwrite: bool = False
    continue_on_error: bool = False
    limit: int | None = None
    hash_filter: str | None = None
    workflows: list[str] | None = None
    model: str | None = None
    language: str | None = None
    nemo_parallel: int | None = None
    nemo_decode_strategy: str | None = None
    nemo_beam_size: int = 2
    nemo_softmax_temperature: float = 1.0
    nemo_beam_length_penalty: float | None = None
    nemo_beam_max_generation_delta: int | None = None

    @classmethod
    def from_args(
        cls,
        args: argparse.Namespace | "TranscribeRequest",
    ) -> "TranscribeRequest":
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
            hash_filter=getattr(args, "hash_filter", None),
            workflows=list(workflows) if workflows is not None else None,
            model=getattr(args, "model", None),
            language=getattr(args, "language", None),
            nemo_parallel=getattr(args, "nemo_parallel", None),
            nemo_decode_strategy=getattr(args, "nemo_decode_strategy", None),
            nemo_beam_size=getattr(args, "nemo_beam_size", 2),
            nemo_softmax_temperature=getattr(args, "nemo_softmax_temperature", 1.0),
            nemo_beam_length_penalty=getattr(args, "nemo_beam_length_penalty", None),
            nemo_beam_max_generation_delta=getattr(args, "nemo_beam_max_generation_delta", None),
        )


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'transcribe' subparser."""
    from besedy.commands.catalog.system import parse_positive_int

    parser = subparsers.add_parser(
        "transcribe",
        help="Generate text transcripts from audio using speech recognition",
        description="""\
Runs speech-to-text transcription using one or more backends:
  canary-nemo     NVIDIA NeMo Canary model (explicit language prompt required)
  faster-whisper  Optimized Whisper implementation (multi-language)
  whisperx        Whisper + alignment (word timestamps, VAD support)
  qwen3-asr       Qwen3-ASR with external Silero VAD segmentation

Requires staged audio: run 'catalog stage-audio' first.

Example:
  catalog transcribe                           # Run default backends
  catalog transcribe --workflow faster-whisper # Only faster-whisper
  catalog transcribe --limit 5                 # Test on 5 files
  catalog transcribe --hash <sha256>           # Transcribe a single file
""",
        formatter_class=formatter_class,
        epilog="Note: WhisperX outputs are written directly in the canonical transcript.json format.",
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
        help="Root directory for transcripts. Default: transcripts_<timestamp>/ with transcripts/ symlink.",
    )
    parser.add_argument(
        "--no-symlink",
        action="store_true",
        help="Do not create or update the transcripts symlink.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing transcripts instead of skipping them.",
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
            "Process up to N files per workflow configuration. Each model/config "
            "is limited independently, ensuring progress across all selected workflows. "
            "Useful for testing or processing in batches."
        ),
    )
    parser.add_argument(
        "--hash",
        dest="hash_filter",
        default=None,
        help="Process only the specified SHA-256 audio hash. Overrides --limit.",
    )
    parser.add_argument(
        "--workflow",
        action="append",
        dest="workflows",
        metavar="WORKFLOW",
        help=(
            "Run only specified backend(s). Can be repeated: --workflow canary-nemo "
            "--workflow faster-whisper. Default: all configured transcription workflows. "
            "Matches workflow_id or workflow_label (and workflow_id family prefixes like "
            "canary-nemo -> canary-nemo-beam) and runs all configured models for that workflow."
        ),
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Select a configured model for the chosen workflow (requires a single --workflow).",
    )
    parser.add_argument(
        "--language",
        default=None,
        help=(
            "Select configured workflow variants by their `language` value in "
            "besedy.toml (e.g. 'cs', or 'auto' for variants configured with "
            "automatic detection). This selects among configured variants; it "
            "does not override a variant's language."
        ),
    )
    parser.add_argument(
        "--nemo-parallel",
        type=parse_positive_int,
        default=None,
        help="Parallel NeMo processes. Usually 1 due to GPU memory requirements.",
    )
    parser.add_argument(
        "--nemo-decode-strategy",
        choices=("greedy", "beam"),
        default=None,
        help="Filter NeMo configs by decoding strategy (greedy or beam).",
    )
    parser.add_argument(
        "--nemo-beam-size",
        type=int,
        default=2,
        help="Beam size when using NeMo beam decoding.",
    )
    parser.add_argument(
        "--nemo-softmax-temperature",
        type=float,
        default=1.0,
        help="Softmax temperature when using NeMo beam decoding.",
    )
    parser.add_argument(
        "--nemo-beam-length-penalty",
        type=float,
        default=None,
        help="Length penalty (len_pen) when using NeMo beam decoding.",
    )
    parser.add_argument(
        "--nemo-beam-max-generation-delta",
        type=int,
        default=None,
        help="Max output length delta when using NeMo beam decoding.",
    )
    parser.set_defaults(func=handle_transcribe)
    return parser


def selection_values_matching(config: WorkflowConfig, selection: set[str]) -> set[str]:
    """Return the --workflow values that select the given workflow.

    A value matches an exact workflow ID or label, or acts as a prefix for
    related IDs (for example `canary` selecting `canary-nemo-beam`).
    """
    exact = {value for value in selection if value in (config.workflow_id, config.workflow_label)}
    prefixes = {
        value for value in selection - exact if config.workflow_id.startswith(f"{value}-")
    }
    return exact | prefixes


def handle_transcribe(
    args: argparse.Namespace | TranscribeRequest,
) -> int:
    """Run transcription workflows (NeMo, Whisper)."""
    request = TranscribeRequest.from_args(args)
    hash_filter = request.hash_filter

    # Resolve --workflow selections before touching the catalog or output root so
    # a typo cannot leave a timestamped output directory behind.
    requested_configs: list[WorkflowConfig] | None = None
    if request.workflows:
        configured_workflows = get_transcription_workflows()
        selection = set(request.workflows)
        matched_values: set[str] = set()
        requested_configs = []
        for cfg in configured_workflows:
            cfg_matches = selection_values_matching(cfg, selection)
            if cfg_matches:
                matched_values |= cfg_matches
                requested_configs.append(cfg)

        unknown_values = sorted(selection - matched_values)
        if unknown_values:
            configured = sorted(
                {
                    value
                    for cfg in configured_workflows
                    for value in (cfg.workflow_id, cfg.workflow_label)
                    if value
                }
            )
            print(
                f"Error: unknown --workflow value(s): {', '.join(unknown_values)}. "
                f"Configured workflows: {', '.join(configured) or '<none>'}.",
                file=sys.stderr,
            )
            return 1

    if hash_filter and request.limit is not None:
        print("Note: --hash overrides --limit.", file=sys.stderr)
    missing_limit = None if hash_filter else request.limit
    # Load all rows so --limit can be applied after checking which entries are missing.
    result = resolve_and_load_catalog(request.csv, "transcribe", None)
    if result is None:
        return 0
    csv_path, rows = result

    if hash_filter:
        target_hash = hash_filter.strip().lower()
        if not SHA256_HASH_PATTERN.match(target_hash):
            print(
                "Error: --hash must be a 64-character lowercase SHA-256 hex string.",
                file=sys.stderr,
            )
            return 1
        rows = [row for row in rows if row.sha256.strip().lower() == target_hash]
        if not rows:
            print(
                f"Error: hash {target_hash} not found in {csv_path.name}.",
                file=sys.stderr,
            )
            return 1

    run_id, base_name = extract_run_info(csv_path)

    if not setup_output_root(request, csv_path, run_id, base_name):
        return 1
    if request.output_root is None:
        print("Error: transcribe output root was not resolved.", file=sys.stderr)
        return 1

    selected_configs = (
        requested_configs
        if requested_configs is not None
        else get_transcription_workflows(pipeline_only=True)
    )

    if request.nemo_decode_strategy:
        selected_configs = [
            cfg
            for cfg in selected_configs
            if cfg.workflow_id not in {"canary-nemo", "canary-nemo-beam"}
            or cfg.decode_strategy == request.nemo_decode_strategy
        ]

    if request.model:
        if not request.workflows or len(set(request.workflows)) != 1:
            print(
                "Error: --model requires exactly one --workflow selection.",
                file=sys.stderr,
            )
            return 1
        selected_configs = [cfg for cfg in selected_configs if cfg.model_name == request.model]
        if not selected_configs:
            print(
                f"Error: model {request.model!r} not configured for workflow {request.workflows[0]!r}.",
                file=sys.stderr,
            )
            return 1

    if request.language is not None:
        requested_language = request.language.strip()
        if not requested_language:
            print("Error: --language must not be empty.", file=sys.stderr)
            return 1
        selected_configs = [
            cfg for cfg in selected_configs if matches_language(cfg, requested_language)
        ]
        if not selected_configs:
            print(
                f"Error: language {request.language!r} is not configured for the selected workflow.",
                file=sys.stderr,
            )
            return 1

    if not selected_configs:
        print("Error: no transcription workflows match the requested filters.", file=sys.stderr)
        return 1

    output_root = resolve_output_root(request.output_root)

    workflow_dirs = {cfg: path_builder(cfg).workflow_dir(output_root) for cfg in selected_configs}

    # Build per-config candidate lists (before applying limit)
    # Each config tracks its candidates independently
    candidates_by_config: dict[WorkflowConfig, list[tuple[CsvAudioRow, str]]] = {
        cfg: [] for cfg in selected_configs
    }
    align_candidates_by_config: dict[WorkflowConfig, list[tuple[CsvAudioRow, str]]] = {
        cfg: [] for cfg in selected_configs
    }
    # Track rows that don't need any work (for pre_skipped when not using limit)
    rows_needing_no_work: list[CsvAudioRow] = []

    for row in rows:
        hash_component = hash_component_from_sha(row.sha256)
        row_needs_any_work = False

        for cfg in selected_configs:
            base_dir = workflow_dirs[cfg] / hash_component
            if cfg.workflow_id in {"canary-nemo", "canary-nemo-beam"}:
                if cfg.decode_strategy == "beam":
                    segments_exists = (base_dir / "nemo_beam_segments.json").exists()
                    transcript_exists = (base_dir / "transcript.json").exists()
                    need_nemo = request.overwrite or not segments_exists
                    need_align = request.overwrite or not transcript_exists
                    if need_nemo:
                        candidates_by_config[cfg].append((row, hash_component))
                        row_needs_any_work = True
                    if need_align:
                        align_candidates_by_config[cfg].append((row, hash_component))
                        row_needs_any_work = True
                else:
                    transcript_exists = (base_dir / "transcript.json").exists()
                    need_nemo = request.overwrite or not transcript_exists
                    if need_nemo:
                        candidates_by_config[cfg].append((row, hash_component))
                        row_needs_any_work = True
            else:
                transcript_exists = (base_dir / "transcript.json").exists()
                need_run = request.overwrite or not transcript_exists
                if need_run:
                    candidates_by_config[cfg].append((row, hash_component))
                    row_needs_any_work = True

        if not row_needs_any_work:
            rows_needing_no_work.append(row)

    # Apply limit per config independently
    # This ensures each workflow/model configuration makes progress independently
    if missing_limit is not None:
        for cfg in selected_configs:
            candidates_by_config[cfg] = candidates_by_config[cfg][:missing_limit]
            align_candidates_by_config[cfg] = align_candidates_by_config[cfg][:missing_limit]

    # Build pending_by_config and align_by_config from (potentially limited) candidates
    pending_by_config: dict[WorkflowConfig, set[str]] = {cfg: set() for cfg in selected_configs}
    align_by_config: dict[WorkflowConfig, set[str]] = {cfg: set() for cfg in selected_configs}
    for cfg in selected_configs:
        for row, hash_component in candidates_by_config[cfg]:
            pending_by_config[cfg].add(hash_component)
        for row, hash_component in align_candidates_by_config[cfg]:
            align_by_config[cfg].add(hash_component)

    # Collect all rows that will be processed (union across all configs)
    # Preserve original catalog order
    selected_sha256s: set[str] = set()
    for cfg in selected_configs:
        for row, hash_component in candidates_by_config[cfg]:
            selected_sha256s.add(row.sha256)
        for row, hash_component in align_candidates_by_config[cfg]:
            selected_sha256s.add(row.sha256)

    filtered_rows: list[CsvAudioRow] = [row for row in rows if row.sha256 in selected_sha256s]

    # Build pre_skipped list (only when not using limit)
    pre_skipped: list[SkippedEntry] = []
    if missing_limit is None:
        for row in rows_needing_no_work:
            pre_skipped.append(
                SkippedEntry(row.sha256, Path(row.full_path).expanduser(), ALREADY_EXISTS_REASON)
            )

    if not filtered_rows:
        print("No audio files require transcription.")
        print_workflow_summary([], pre_skipped, [])
        return 1 if has_error_skips(pre_skipped) else 0

    prepared, validation_errors = validate_staged_audio(filtered_rows)
    skipped_total = list(pre_skipped)
    if validation_errors:
        if not request.continue_on_error:
            print_validation_errors(validation_errors, "transcribe")
            return 1
        skipped_total.extend(
            SkippedEntry(sha, path, reason) for sha, path, reason in validation_errors
        )

    if not prepared:
        print("No staged audio files passed validation; nothing to do.")
        print_workflow_summary(prepared, skipped_total, [])
        return 1 if has_error_skips(skipped_total) else 0

    transcription_jobs: list[TranscriptionJob] = []
    for cfg in selected_configs:
        hashes = pending_by_config.get(cfg, set())
        align_hashes = align_by_config.get(cfg, set())
        if hashes or align_hashes:
            transcription_jobs.append(
                TranscriptionJob(cfg, hashes=hashes, align_hashes=align_hashes)
            )

    workflow_config = WorkflowRunConfig(
        output_root=output_root,
        overwrite=request.overwrite,
        enable_pyannote_diarization=False,
        nemo_parallel=request.nemo_parallel,
        nemo_beam_size=request.nemo_beam_size,
        nemo_softmax_temperature=request.nemo_softmax_temperature,
        nemo_beam_length_penalty=request.nemo_beam_length_penalty,
        nemo_beam_max_generation_delta=request.nemo_beam_max_generation_delta,
        pyannote_parallel=None,
        pyannote_min_speakers=None,
        pyannote_max_speakers=None,
        pyannote_clustering_threshold=None,
    )

    workflows = build_workflows(
        prepared,
        workflow_config,
        transcription_jobs=transcription_jobs,
        hashes_for_pyannote_diarization=set(),
    )

    if not workflows:
        print("No workflows to run.")
        print_workflow_summary(prepared, skipped_total, [])
        return 1 if has_error_skips(skipped_total) else 0

    base_env = prepare_workflow_env()
    failures = launch_workflows(workflows, base_env)

    print_workflow_summary(prepared, skipped_total, failures)
    return 0 if not failures and not has_error_skips(skipped_total) else 1
