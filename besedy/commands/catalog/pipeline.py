"""Run the full catalog processing pipeline."""

from __future__ import annotations

import argparse
import csv
import logging
import sys
from pathlib import Path

from besedy.commands.catalog import pipeline_rag as _pipeline_rag
from besedy.commands.catalog.archive import ArchiveRequest, handle_archive
from besedy.commands.catalog.csv_utils import resolve_catalog_csv
from besedy.commands.catalog.diarize import DiarizeRequest, handle_diarize
from besedy.commands.catalog.extract import ExportTranscriptsRequest, handle_export_transcripts
from besedy.commands.catalog.loudness import LoudnessRequest, handle_loudness
from besedy.commands.catalog.pipeline_rag import (
    COLBERT_RUNTIME_CHOICES,
    COLBERT_RUNTIME_ENV_VAR,
    DEFAULT_INDEX_BSIZE,
    DEFAULT_MAX_CHUNK_TOKENS,
    DEFAULT_MIN_CHUNK_TOKENS,
    DEFAULT_OVERLAP_TOKENS,
)
from besedy.commands.catalog.rag_colbert_index import (
    handle_rag_colbert_index,
)
from besedy.commands.catalog.speakers import ClusterSpeakersRequest, handle_cluster_speakers
from besedy.commands.catalog.stage import StageAudioRequest, handle_stage_audio
from besedy.commands.catalog.transcribe import TranscribeRequest, handle_transcribe
from besedy.core.paths import (
    PYANNOTE_DIARIZATION_MODEL_NAME,
    PYANNOTE_DIARIZATION_WORKFLOW_LABEL,
    extract_timestamp_from_catalog,
    resolve_catalogs_root,
    resolve_transcripts_parent,
    sanitize_component,
)
from besedy.lib.rag_colbert import check_colbert_runtime_ready, default_colbert_index_runtime
from besedy.lib.workflow.config import (
    WorkflowConfig,
    get_diarization_workflows,
    get_transcription_workflows,
)

# Pipeline step definitions (for documentation/reference only)
CORE_STEPS = [
    ("loudness", "Analyzing audio loudness"),
    ("stage-audio", "Normalizing audio files"),
    ("archive", "Compressing to Opus"),
    ("transcribe", "Running transcription"),
    ("diarize", "Running diarization"),
]

DERIVED_STEPS = [
    ("export-transcripts", "Exporting transcript sidecars"),
    ("cluster-speakers", "Clustering speakers"),
]

logger = logging.getLogger(__name__)


def resolve_pipeline_workflows() -> tuple[list[WorkflowConfig], list[str]]:
    """Load configured workflows when the pipeline command is executed."""
    transcription_workflows = get_transcription_workflows(pipeline_only=True)
    diarization_workflow_ids = [w.workflow_id for w in get_diarization_workflows()]
    return transcription_workflows, diarization_workflow_ids


def derive_staging_dir_from_normalized_csv(csv_path: Path) -> Path | None:
    """Derive the staging directory from the normalized CSV's Full Path column.

    Returns the parent directory of the first entry's Full Path, or None if
    the CSV doesn't exist or has no entries.
    """
    if not csv_path.exists():
        return None

    try:
        with csv_path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                full_path = row.get("Full Path", "")
                if full_path:
                    staged_file = Path(full_path)
                    if staged_file.exists():
                        return staged_file.parent
                    # Even if file doesn't exist, derive from path
                    return staged_file.parent
    except Exception as exc:
        logger.debug("failed to derive staging dir from %s: %s", csv_path, exc)

    return None


def print_step(step_num: int, total: int, name: str, detail: str = "") -> None:
    """Print a step header."""
    detail_str = f" ({detail})" if detail else ""
    print(f"\n[{step_num}/{total}] {name}{detail_str}...")
    print("=" * 60)


def rag_backend_key_for_workflow(workflow: WorkflowConfig) -> str:
    return _pipeline_rag.rag_backend_key_for_workflow(workflow)


def backend_has_transcripts(transcripts_root: Path, workflow: WorkflowConfig) -> bool:
    return _pipeline_rag.backend_has_transcripts(transcripts_root, workflow)


def _resolve_pipeline_rag_backend_key(args: argparse.Namespace) -> str:
    return _pipeline_rag._resolve_pipeline_rag_backend_key(args)


def select_rag_workflows(
    args: argparse.Namespace,
    workflows: list[WorkflowConfig],
) -> tuple[list[WorkflowConfig], str | None]:
    return _pipeline_rag.select_rag_workflows(
        args,
        workflows,
        resolve_backend_key=_resolve_pipeline_rag_backend_key,
    )


def should_run_rag_colbert_index(args: argparse.Namespace) -> bool:
    return _pipeline_rag.should_run_rag_colbert_index(
        args,
        resolve_runtime=_resolve_pipeline_colbert_runtime,
        runtime_ready_check=check_colbert_runtime_ready,
    )


def _resolve_pipeline_colbert_runtime(args: argparse.Namespace) -> str:
    return _pipeline_rag._resolve_pipeline_colbert_runtime(
        args,
        default_runtime_resolver=default_colbert_index_runtime,
    )


def _resolve_pipeline_colbert_index_dir(
    args: argparse.Namespace,
    *,
    backend_key: str,
) -> Path | None:
    return _pipeline_rag._resolve_pipeline_colbert_index_dir(args, backend_key=backend_key)


def run_rag_colbert_index_for_workflow(
    args: argparse.Namespace,
    *,
    workflow_group_id: str,
    transcripts_root: Path,
    workflow: WorkflowConfig,
) -> int:
    return _pipeline_rag.run_rag_colbert_index_for_workflow(
        args,
        workflow_group_id=workflow_group_id,
        transcripts_root=transcripts_root,
        workflow=workflow,
        has_transcripts=backend_has_transcripts,
        resolve_runtime=_resolve_pipeline_colbert_runtime,
        resolve_index_dir=lambda local_args, local_backend: _resolve_pipeline_colbert_index_dir(
            local_args,
            backend_key=local_backend,
        ),
        handle_index=handle_rag_colbert_index,
    )


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'run-pipeline' subparser."""
    from pathlib import Path

    from besedy.commands.catalog.system import parse_positive_int

    parser = subparsers.add_parser(
        "run-pipeline",
        help="Run the complete processing pipeline from catalog to transcripts",
        description="""\
Automated pipeline that runs all processing steps in sequence:
  1. loudness     Analyze audio loudness
  2. stage-audio  Normalize to 16kHz mono WAV
  3. archive      Compress to Opus/WebM
  4. transcribe   Generate transcripts (configured backends)
  5. rag-colbert-index  Build/update ColBERT sidecar indexes for the active backend scope
  6. diarize      Identify speakers (configured diarization backends)
  7. derived      Export subtitles, cluster speakers
Example:
  catalog run-pipeline
  catalog run-pipeline --skip-derived                       # Skip post-processing
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Source catalog CSV. Default: audio_catalog.csv symlink.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continue to next pipeline step even if a step fails.",
    )
    parser.add_argument(
        "--skip-derived",
        action="store_true",
        help="Skip post-processing: subtitle export and speaker clustering. Run these separately later if needed.",
    )
    parser.add_argument(
        "--no-symlink",
        action="store_true",
        help="Do not create or update symlinks in any pipeline step.",
    )
    parser.add_argument(
        "--skip-rag-colbert-index",
        action="store_true",
        help="Skip ColBERT sidecar indexing after transcription.",
    )
    parser.add_argument(
        "--rag-backend",
        default=None,
        help=(
            "RAG backend key to index during run-pipeline. "
            "Default: active RAG_BACKEND_KEY from the selected env file or repo default."
        ),
    )
    parser.add_argument(
        "--rag-all-backends",
        action="store_true",
        help="Index RAG for every transcription backend instead of only the active RAG backend.",
    )
    parser.add_argument(
        "--rag-force",
        action="store_true",
        help="Force-refresh ColBERT RAG for the selected scope even when transcripts are unchanged.",
    )
    parser.add_argument(
        "--rag-colbert-index-dir",
        type=Path,
        default=None,
        help="Optional explicit ColBERT sidecar directory override for pipeline indexing.",
    )
    parser.add_argument(
        "--rag-colbert-model",
        default=None,
        help="ColBERT checkpoint used for pipeline sidecar indexing.",
    )
    parser.add_argument(
        "--rag-chunk-tokenizer-model",
        default=None,
        help=(
            "Tokenizer model used for pipeline chunk sizing. "
            "Default: use the active pipeline ColBERT model."
        ),
    )
    parser.add_argument(
        "--rag-colbert-doc-maxlen",
        type=int,
        default=384,
        help="ColBERT doc_maxlen used for pipeline sidecar indexing.",
    )
    parser.add_argument(
        "--rag-colbert-index-bsize",
        type=parse_positive_int,
        default=DEFAULT_INDEX_BSIZE,
        help=(
            "ColBERT indexing batch size used for pipeline sidecar indexing. "
            f"Default: {DEFAULT_INDEX_BSIZE}."
        ),
    )
    parser.add_argument(
        "--rag-colbert-use-faiss",
        action="store_true",
        help="Enable FAISS when building ColBERT sidecar indexes during the pipeline.",
    )
    parser.add_argument(
        "--rag-colbert-runtime",
        choices=COLBERT_RUNTIME_CHOICES,
        default=None,
        help=(
            "Optional ColBERT runtime override for pipeline indexing. "
            f"Default: use {COLBERT_RUNTIME_ENV_VAR} when set, otherwise "
            "'docker-indexer' on GPU hosts and 'docker' on CPU-only hosts."
        ),
    )
    parser.add_argument(
        "--rag-min-chunk-tokens",
        type=int,
        default=DEFAULT_MIN_CHUNK_TOKENS,
        help="Minimum chunk token count for pipeline RAG ingest.",
    )
    parser.add_argument(
        "--rag-max-chunk-tokens",
        type=int,
        default=DEFAULT_MAX_CHUNK_TOKENS,
        help="Maximum chunk token count for pipeline RAG ingest.",
    )
    parser.add_argument(
        "--rag-overlap-tokens",
        type=int,
        default=DEFAULT_OVERLAP_TOKENS,
        help="Chunk overlap token count for pipeline RAG ingest.",
    )
    parser.set_defaults(func=handle_run_pipeline)
    return parser


def handle_run_pipeline(args: argparse.Namespace) -> int:
    """Execute the full pipeline: stage -> transcribe -> diarize -> derived artifacts."""

    # Resolve catalog CSV path
    try:
        csv_path = resolve_catalog_csv(
            args.csv,
            purpose="pipeline",
            default_symlink=resolve_catalogs_root() / "audio_catalog.csv",
        )
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    continue_on_error = args.continue_on_error
    skip_derived = args.skip_derived
    no_symlink = bool(getattr(args, "no_symlink", False))

    timestamp = extract_timestamp_from_catalog(csv_path.resolve())
    if not timestamp:
        print(
            f"Error: source catalog must be timestamped as audio_catalog_<YYYYMMDD_HHMMSS>.csv. Got: {csv_path.name}",
            file=sys.stderr,
        )
        return 1

    transcribe_workflows, diarize_workflow_ids = resolve_pipeline_workflows()

    rag_colbert_index_enabled = should_run_rag_colbert_index(args)
    rag_workflows: list[WorkflowConfig] = []
    rag_target_backend: str | None = None
    if rag_colbert_index_enabled:
        try:
            rag_workflows, rag_target_backend = select_rag_workflows(args, transcribe_workflows)
        except RuntimeError as exc:
            print(
                f"Error: cannot resolve the RAG backend key: {exc} "
                "Set RAG_BACKEND_KEY or --rag-backend, or pass --skip-rag-colbert-index.",
                file=sys.stderr,
            )
            return 1
        if not rag_workflows and rag_target_backend is None:
            # --rag-all-backends with no pipeline transcription workflows:
            # there is nothing to index, but the remaining steps are still useful.
            rag_colbert_index_enabled = False
            print(
                "Note: skipping rag-colbert-index because no transcription workflows "
                "are enabled for the pipeline.",
                file=sys.stderr,
            )
        elif not rag_workflows:
            active_backends = (
                ", ".join(
                    sorted(
                        rag_backend_key_for_workflow(workflow) for workflow in transcribe_workflows
                    )
                )
                or "<none>"
            )
            print(
                (
                    f"Error: selected RAG backend {rag_target_backend} does not exactly match "
                    "an active pipeline transcription workflow. Update RAG_BACKEND_KEY or "
                    "--rag-backend (or pass --skip-rag-colbert-index), then rebuild the index. "
                    f"Active backends: {active_backends}."
                ),
                file=sys.stderr,
            )
            return 1
        elif rag_target_backend is not None:
            print(
                f"Note: pipeline rag-colbert-index targeting backend {rag_target_backend}.",
                file=sys.stderr,
            )

    setattr(args, "_pipeline_multi_rag_backend_selection", len(rag_workflows) > 1)

    # Use the transcripts parent container so we don't double-append the run id
    # when the "transcripts" symlink already points at a timestamped directory.
    transcripts_run_root = resolve_transcripts_parent() / f"transcripts_{timestamp}"

    # Calculate total steps dynamically (each workflow is a separate step)
    total_steps = 3  # loudness, stage-audio, archive
    total_steps += len(transcribe_workflows)  # each transcription workflow
    if rag_colbert_index_enabled:
        total_steps += len(rag_workflows)  # selected rag-colbert-index workflow(s)
    total_steps += len(diarize_workflow_ids)  # each diarization workflow
    if not skip_derived:
        total_steps += 2  # export-transcripts, cluster-speakers

    failures: list[tuple[str, str]] = []
    step_num = 0

    rag_backend_keys = {rag_backend_key_for_workflow(workflow) for workflow in rag_workflows}

    # =========================================================================
    # STEP 1: audio preparation
    # =========================================================================
    # Step: Loudness analysis
    step_num += 1
    print_step(step_num, total_steps, "loudness", "Analyzing audio loudness")

    loudness_csv = csv_path.with_name(f"{csv_path.stem}_loudness.csv")
    loudness_args = LoudnessRequest(
        csv=csv_path,
        output=loudness_csv,
        parallel=None,
        overwrite=False,  # Incremental: only analyze files missing loudness data
        ffprobe_binary="ffprobe",
        ffmpeg_binary="ffmpeg",
        encoding="utf-8",
        no_color=False,
        no_symlink=no_symlink,
    )

    result = handle_loudness(loudness_args)
    if result != 0:
        failures.append(("loudness", "Loudness analysis failed"))
        if not continue_on_error:
            print(f"\nPipeline stopped: loudness failed with exit code {result}")
            return 1

    # Step: Stage audio
    step_num += 1
    print_step(step_num, total_steps, "stage-audio", "Normalizing to 16kHz mono WAV")

    stage_args = StageAudioRequest(
        csv=loudness_csv,  # Use loudness CSV (has needs_normalization column)
        output_dir=None,  # Use default from audio_artifacts_dir
        skip_audio_analysis=False,  # Include audio analysis by default
        no_aggressive_normalization=False,
        continue_on_error=True,  # Always continue within stage-audio
        limit=None,
        ffprobe_binary="ffprobe",
        ffmpeg_binary="ffmpeg",
        no_symlink=no_symlink,
    )

    result = handle_stage_audio(stage_args)
    if result != 0:
        failures.append(("stage-audio", "Audio staging failed"))
        if not continue_on_error:
            print(f"\nPipeline stopped: stage-audio failed with exit code {result}")
            return 1

    workflow_csv = loudness_csv.with_name(f"{loudness_csv.stem}_normalized.csv")

    # Step: Archive (parallel to stage-audio conceptually)
    step_num += 1
    print_step(step_num, total_steps, "archive", "Compressing to Opus")

    archive_args = ArchiveRequest(
        csv=loudness_csv,  # Same input as stage-audio
        output_dir=None,  # Use default (audio_archive/)
        format="opus",
        quality="medium",
        stereo=False,  # mono
        parallel=None,
        overwrite=False,  # Don't overwrite existing
        continue_on_error=True,
        limit=None,
        ffmpeg_binary="ffmpeg",
        ffprobe_binary="ffprobe",
        bitrate=None,
        no_symlink=no_symlink,
    )

    result = handle_archive(archive_args)
    if result != 0:
        failures.append(("archive", "Audio archiving failed"))
        if not continue_on_error:
            print(f"\nPipeline stopped: archive failed with exit code {result}")
            return 1

    # =========================================================================
    # STEPS 2-N: transcribe (each workflow is a separate step)
    # =========================================================================
    for workflow in transcribe_workflows:
        step_num += 1
        print_step(
            step_num, total_steps, "transcribe", workflow.output_component(sanitize_component)
        )

        transcribe_args = TranscribeRequest(
            csv=workflow_csv,
            output_root=None,  # Let handler resolve from text_data_dir
            no_symlink=no_symlink,
            overwrite=False,
            continue_on_error=True,
            limit=None,
            hash_filter=None,
            workflows=[workflow.workflow_id],
            model=workflow.model_name,
            language=workflow.language,
            nemo_parallel=None,
            nemo_decode_strategy=workflow.decode_strategy,
            nemo_beam_size=2,
            nemo_softmax_temperature=1.0,
            nemo_beam_length_penalty=None,
            nemo_beam_max_generation_delta=None,
        )

        result = handle_transcribe(transcribe_args)
        if result != 0:
            failures.append((f"transcribe ({workflow})", f"Transcription failed for {workflow}"))
            if not continue_on_error:
                print(f"\nPipeline stopped: transcribe ({workflow}) failed with exit code {result}")
                return 1

        backend_key = rag_backend_key_for_workflow(workflow)
        if rag_colbert_index_enabled and backend_key in rag_backend_keys:
            step_num += 1
            print_step(step_num, total_steps, "rag-colbert-index", backend_key)

            try:
                result = run_rag_colbert_index_for_workflow(
                    args,
                    workflow_group_id=timestamp,
                    transcripts_root=transcripts_run_root,
                    workflow=workflow,
                )
            except Exception as exc:
                failures.append(
                    (
                        f"rag-colbert-index ({backend_key})",
                        f"ColBERT indexing failed for {backend_key}: {exc}",
                    )
                )
                if not continue_on_error:
                    print(f"\nPipeline stopped: rag-colbert-index ({backend_key}) failed: {exc}")
                    return 1
            else:
                if result != 0:
                    failures.append(
                        (
                            f"rag-colbert-index ({backend_key})",
                            f"ColBERT indexing failed for {backend_key}",
                        )
                    )
                    if not continue_on_error:
                        print(
                            f"\nPipeline stopped: rag-colbert-index ({backend_key}) failed with exit code {result}"
                        )
                        return 1

    # =========================================================================
    # STEPS N+1 to M: diarize (each workflow is a separate step)
    # =========================================================================
    for workflow in diarize_workflow_ids:
        step_num += 1
        print_step(step_num, total_steps, "diarize", workflow)

        diarize_args = DiarizeRequest(
            csv=workflow_csv,
            output_root=None,  # Let handler resolve from text_data_dir
            no_symlink=no_symlink,
            overwrite=False,
            continue_on_error=True,
            limit=None,
            workflows=[workflow],
            pyannote_parallel=None,
            pyannote_min_speakers=None,
            pyannote_max_speakers=None,
            pyannote_clustering_threshold=None,
        )

        result = handle_diarize(diarize_args)
        if result != 0:
            failures.append((f"diarize ({workflow})", f"Diarization failed for {workflow}"))
            if not continue_on_error:
                print(f"\nPipeline stopped: diarize ({workflow}) failed with exit code {result}")
                return 1

    # =========================================================================
    # DERIVED ARTIFACTS (optional)
    # =========================================================================

    if not skip_derived:
        # export-transcripts
        step_num += 1
        print_step(step_num, total_steps, "export-transcripts", "Generating txt/srt/vtt files")

        extract_args = ExportTranscriptsRequest(
            transcripts_root=transcripts_run_root,
            workflow=None,
            model=None,
            stats=False,
            overwrite=False,
        )

        result = handle_export_transcripts(extract_args)
        if result != 0:
            failures.append(("export-transcripts", "Transcript export failed"))
            if not continue_on_error:
                print(f"\nPipeline stopped: export-transcripts failed with exit code {result}")
                return 1

        # cluster-speakers
        step_num += 1
        print_step(step_num, total_steps, "cluster-speakers", "Cross-file speaker matching")

        cluster_args = ClusterSpeakersRequest(
            cpu=False,
            model="pyannote",
            input_dir=(
                transcripts_run_root
                / PYANNOTE_DIARIZATION_WORKFLOW_LABEL
                / PYANNOTE_DIARIZATION_MODEL_NAME
            ),
            cluster_distance=None,
            min_duration=None,
            embedding_cache_mode=None,
            embedding_cache_dir=None,
            refresh_embedding_cache=False,
            output=None,
            no_symlink=no_symlink,
            hashes=[],
        )

        result = handle_cluster_speakers(cluster_args)
        if result != 0:
            failures.append(("cluster-speakers", "Speaker clustering failed"))
            if not continue_on_error:
                print(f"\nPipeline stopped: cluster-speakers failed with exit code {result}")
                return 1

    # =========================================================================
    # SUMMARY
    # =========================================================================
    print("\n" + "=" * 60)
    print("PIPELINE SUMMARY")
    print("=" * 60)

    if not failures:
        print("\nAll steps completed successfully!")
        return 0
    else:
        print(f"\n{len(failures)} step(s) had issues:")
        for step_name, message in failures:
            print(f"  - {step_name}: {message}")
        print("\nRun 'just catalog check' to see detailed status.")
        return 1
