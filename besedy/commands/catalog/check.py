"""Catalog validation and check command."""

from __future__ import annotations

import argparse
import sqlite3
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn

from besedy.commands.catalog.csv_utils import resolve_catalog_csv
from besedy.commands.catalog.default_paths import (
    get_default_archived_symlink,
    get_default_catalog_symlink,
    get_default_loudness_symlink,
    get_default_normalized_symlink,
)
from besedy.config.settings import config
from besedy.core.cli_output import JsonStatus, print_json_result
from besedy.core.paths import (
    extract_run_id_from_transcripts_root,
    extract_timestamp_from_catalog,
    extract_timestamp_from_normalized_catalog,
    extract_timestamp_from_transcripts_root,
    resolve_transcripts_parent,
    resolve_transcripts_root,
)
from besedy.core.paths_transcripts import parse_transcript_components
from besedy.lib.analysis.coverage import (
    expected_asr_backends_from_code,
    expected_diarization_backends_from_code,
    require_archived_audio,
    require_loudness_catalog,
    require_speaker_clusters,
    require_transcript_exports,
)
from besedy.lib.catalog.validator import (
    ValidationResult,
    format_validation_report,
    load_catalog_csv,
    validate_catalog,
)
from besedy.lib.rag_bundle import ResolvedColbertBundle, resolve_colbert_scope_bundle
from besedy.lib.rag_colbert import resolve_default_colbert_model
from besedy.lib.rag_colbert_source_state import read_source_state
from besedy.lib.workflow.config import WorkflowConfig, get_transcription_workflows
from besedy.lib.workflow.paths import sanitize_model_identifier


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'check' subparser."""
    from pathlib import Path

    parser = subparsers.add_parser(
        "check",
        help="Verify pipeline integrity: staged files, transcripts, diarization",
        description="""\
Reports which catalog entries are missing staged audio, transcripts, or
diarization outputs. Useful for identifying incomplete processing.

Example:
  catalog check --verbose              # Show missing files
  catalog check --format json | jq .   # Machine-readable output
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Original catalog with source file paths. Default: audio_catalog.csv symlink.",
    )
    parser.add_argument(
        "--csv-normalized",
        type=Path,
        default=None,
        help="Staged catalog (output of stage-audio) with paths to 16kHz mono WAVs. Default: audio_catalog_normalized.csv symlink.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="List individual files that are missing staged audio, transcripts, or diarization.",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format: text for human reading, json for scripting.",
    )
    parser.set_defaults(func=handle_check)
    return parser


def _rag_backend_key_for_workflow(workflow: WorkflowConfig) -> str:
    model_component = workflow.output_component(sanitize_model_identifier)
    return f"{workflow.workflow_label}/{model_component}"


def _workflow_has_transcripts(transcripts_root: Path, workflow: WorkflowConfig) -> bool:
    backend_key = _rag_backend_key_for_workflow(workflow)
    workflow_dir, model_component = backend_key.split("/", maxsplit=1)
    backend_dir = transcripts_root / workflow_dir / model_component
    if not backend_dir.exists():
        return False
    return any(path.is_file() for path in backend_dir.rglob("transcript.json"))


def _transcript_hashes_for_backend(transcripts_root: Path, backend_key: str) -> set[str]:
    """Return the lowercase audio hashes that have a transcript for one backend."""

    workflow_dir, model_component = backend_key.split("/", maxsplit=1)
    backend_dir = transcripts_root / workflow_dir / model_component
    if not backend_dir.exists():
        return set()

    hashes: set[str] = set()
    for path in backend_dir.rglob("transcript.json"):
        if not path.is_file():
            continue
        components = parse_transcript_components(path, transcripts_root)
        if components:
            hashes.add(components[2].lower())
    return hashes


@dataclass(frozen=True)
class _ColbertCheckScope:
    """Inputs shared by the ColBERT bundle and hash coverage checks."""

    transcripts_root: Path
    run_id: str
    colbert_model: str
    expected_backends: list[str]


def _resolve_colbert_check_scope(
    transcripts_root: Path,
    check_label: str,
) -> tuple[_ColbertCheckScope | None, str | None]:
    """Resolve run ID, ColBERT model, and backends with transcripts.

    Returns (scope, skip_message) with exactly one of the two set.
    """

    transcripts_resolved = (
        transcripts_root.resolve() if transcripts_root.is_symlink() else transcripts_root
    )
    run_id = extract_run_id_from_transcripts_root(transcripts_resolved)
    if not run_id:
        return (
            None,
            f"Unable to determine transcript run ID; skipping ColBERT {check_label} check.",
        )

    expected_backends = [
        _rag_backend_key_for_workflow(workflow)
        for workflow in get_transcription_workflows(expected_only=True)
        if _workflow_has_transcripts(transcripts_resolved, workflow)
    ]
    if not expected_backends:
        return (
            None,
            "No transcription backends with transcripts found; "
            f"skipping ColBERT {check_label} check.",
        )

    return (
        _ColbertCheckScope(
            transcripts_root=transcripts_resolved,
            run_id=run_id,
            colbert_model=resolve_default_colbert_model(),
            expected_backends=expected_backends,
        ),
        None,
    )


def _resolve_backend_bundle(
    scope: _ColbertCheckScope,
    backend_key: str,
) -> tuple[ResolvedColbertBundle | None, str | None]:
    """Resolve one backend's ColBERT bundle, returning (bundle, error_message)."""

    try:
        bundle = resolve_colbert_scope_bundle(
            workflow_group_id=scope.run_id,
            backend_key=backend_key,
            colbert_model=scope.colbert_model,
        )
    except RuntimeError as exc:
        return None, str(exc)
    return bundle, None


def require_colbert_bundles(
    transcripts_root: Path,
) -> tuple[bool | None, str | None, dict | None]:
    """Ensure live-search ColBERT bundles exist for transcription backends with transcripts."""

    scope, skip_message = _resolve_colbert_check_scope(transcripts_root, "bundle")
    if scope is None:
        return None, skip_message, None

    resolved_backends: list[str] = []
    missing_backends: list[str] = []
    compatibility_errors: list[str] = []
    for backend_key in scope.expected_backends:
        bundle, resolve_error = _resolve_backend_bundle(scope, backend_key)
        if resolve_error is not None:
            compatibility_errors.append(f"{backend_key}: {resolve_error}")
        if bundle is None:
            missing_backends.append(backend_key)
        else:
            resolved_backends.append(backend_key)

    stats = {
        "total": len(resolved_backends),
        "expected": len(scope.expected_backends),
        "missing": len(missing_backends),
        "resolved_backends": resolved_backends,
        "missing_backends": missing_backends,
        "compatibility_errors": compatibility_errors,
        "colbert_model": scope.colbert_model,
    }
    if missing_backends:
        suffix = ""
        if compatibility_errors:
            suffix = " | incompatible bundle(s): " + "; ".join(compatibility_errors)
        return (
            False,
            "Missing ColBERT bundle for backend(s): " + ", ".join(missing_backends) + suffix,
            stats,
        )
    return True, None, stats


def require_colbert_hash_coverage(
    transcripts_root: Path,
    catalog_hashes: set[str],
) -> tuple[bool | None, str | None, dict | None]:
    """Ensure each resolved ColBERT bundle's index covers every transcribed catalog hash.

    Complements `require_colbert_bundles` (which only checks that a bundle
    exists per backend) with per-hash coverage: a bundle can exist but still
    be missing recently-added audio hashes if the sync job silently skipped
    them or hasn't run since ingest.

    Coverage is measured against the hashes that are both in the catalog and
    transcribed for that backend, since ColBERT cannot index audio that has no
    transcript yet. Source state rows with no chunks count as not indexed
    (that is the silent skip this check exists to catch), and indexed hashes
    that have left the catalog are reported as stale.
    """

    scope, skip_message = _resolve_colbert_check_scope(transcripts_root, "hash coverage")
    if scope is None:
        return None, skip_message, None

    catalog_lower = {h.lower() for h in catalog_hashes}
    stats: dict[str, dict] = {}
    incomplete_backends: list[str] = []
    stale_backends: list[str] = []
    unreadable_backends: list[str] = []
    unbuilt_backends: list[str] = []

    for backend_key in scope.expected_backends:
        bundle, _ = _resolve_backend_bundle(scope, backend_key)
        if bundle is None:
            # Bundle entirely missing is already reported by require_colbert_bundles.
            continue

        source_state_path = bundle.artifacts.source_state_path
        if not source_state_path.exists():
            # No source state at all: coverage is unknown, not zero.
            unbuilt_backends.append(backend_key)
            continue

        try:
            source_rows = read_source_state(source_state_path, read_only=True)
        except (OSError, sqlite3.Error) as exc:
            # A concurrent sync holds a write lock, or the file is corrupt;
            # degrade to a reported failure instead of aborting the report.
            unreadable_backends.append(f"{backend_key}: {exc}")
            continue

        indexed_hashes = {
            audio_hash.lower() for audio_hash, row in source_rows.items() if row.chunk_count > 0
        }
        empty_hashes = {
            audio_hash.lower() for audio_hash, row in source_rows.items() if row.chunk_count <= 0
        }
        expected_hashes = catalog_lower & _transcript_hashes_for_backend(
            scope.transcripts_root, backend_key
        )
        missing_hashes = expected_hashes - indexed_hashes
        stale_hashes = indexed_hashes - catalog_lower
        stats[backend_key] = {
            "total": len(expected_hashes & indexed_hashes),
            "expected": len(expected_hashes),
            "missing": len(missing_hashes),
            "missing_hashes": sorted(missing_hashes)[:250],
            "stale": len(stale_hashes),
            "stale_hashes": sorted(stale_hashes)[:250],
            "empty": len(expected_hashes & empty_hashes),
            "not_transcribed": len(catalog_lower - expected_hashes),
        }
        if missing_hashes:
            incomplete_backends.append(backend_key)
        if stale_hashes:
            stale_backends.append(backend_key)

    if unreadable_backends:
        return (
            False,
            "Unable to read ColBERT source state for backend(s): " + "; ".join(unreadable_backends),
            stats or None,
        )

    if not stats and not unbuilt_backends:
        return (
            None,
            "No resolved ColBERT bundles found; skipping ColBERT hash coverage check.",
            None,
        )

    if incomplete_backends:
        details = ", ".join(
            f"{backend} missing {stats[backend]['missing']}"
            + (
                f" ({stats[backend]['empty']} indexed with no chunks)"
                if stats[backend]["empty"]
                else ""
            )
            for backend in incomplete_backends
        )
        return False, f"ColBERT index missing hashes for backend(s): {details}", stats

    if stale_backends:
        details = ", ".join(
            f"{backend} stale {stats[backend]['stale']}" for backend in stale_backends
        )
        return False, f"ColBERT index has stale hashes for backend(s): {details}", stats

    if unbuilt_backends:
        return (
            None,
            "No ColBERT source state for backend(s): "
            + ", ".join(unbuilt_backends)
            + "; skipping ColBERT hash coverage check.",
            stats or None,
        )

    return True, None, stats


_COMMAND_NAME = "check"

# A check reports (ok, message, stats): ok is True, False (needs attention), or
# None (skipped with a reason in message).
CheckOutcome = tuple[bool | None, str | None, dict | None]


@dataclass(frozen=True)
class _CheckSpec:
    """How one check is titled and remedied in the text report."""

    emoji: str
    title: str
    # `just catalog …` line printed when the check fails; `{message}` is the
    # check's own message.
    remedy: str


_CHECK_SPECS: dict[str, _CheckSpec] = {
    "loudness_catalog": _CheckSpec(
        "📈", "Loudness catalog", "just catalog loudness  # Generate loudness catalog"
    ),
    "archived_audio": _CheckSpec(
        "📦", "Archived audio", "just catalog archive   # Generate archived audio"
    ),
    "colbert_bundle": _CheckSpec(
        "🔎",
        "ColBERT bundle",
        "just catalog rag-colbert-index  # Build/update ColBERT sidecar bundles",
    ),
    "transcript_exports": _CheckSpec(
        "📄",
        "Transcript exports",
        "just catalog export-transcripts  # Regenerate transcript sidecars",
    ),
    "colbert_index": _CheckSpec(
        "🔎", "ColBERT hash coverage", "just catalog rag-colbert-index  # {message}"
    ),
    "speaker_clusters": _CheckSpec(
        "👥", "Speaker clusters", "just catalog cluster-speakers  # {message}"
    ),
}


@dataclass
class CheckResult:
    """One check's verdict, keyed by the name used in the JSON output."""

    name: str
    ok: bool | None
    message: str | None
    stats: dict | None

    @property
    def failed(self) -> bool:
        return self.ok is False

    @property
    def remedy_line(self) -> str:
        return "    Run: " + _CHECK_SPECS[self.name].remedy.format(message=self.message)

    def to_json(self) -> dict:
        return {"ok": self.ok, "message": self.message, "stats": self.stats}


def _archived_coverage(archived: CheckResult) -> int | None:
    """Catalog entries the archived catalog covers, or None when unknown."""

    stats = archived.stats
    if stats and "expected" in stats and "missing" in stats:
        return stats["expected"] - stats["missing"]
    return None


class _CheckInputError(Exception):
    """A required input path is missing; the command stops before any check."""

    def __init__(self, code: str, path: Path, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.path = path
        self.message = message


@dataclass(frozen=True)
class _CheckInputs:
    """Resolved paths for a complete pipeline run."""

    csv_path: Path
    csv_normalized_path: Path
    transcripts_root: Path
    loudness_path: Path
    archived_path: Path


@dataclass(frozen=True)
class _IncompletePipeline:
    """A timestamped catalog whose normalized CSV or transcripts root does not exist yet."""

    csv_path: Path
    timestamp: str
    normalized_path: Path
    normalized_symlink: Path
    transcripts_path: Path
    loudness_path: Path
    archived_path: Path


def _resolve_check_inputs(args: argparse.Namespace) -> _CheckInputs | _IncompletePipeline:
    """Resolve the catalog CSV and the pipeline files that belong to it."""

    # Resolve catalog path using getter functions when not provided
    try:
        csv_path = resolve_catalog_csv(
            args.csv,
            purpose="check",
            default_symlink=get_default_catalog_symlink(),
        )
    except FileNotFoundError as exc:
        raise _CheckInputError(
            "catalog_csv_missing", args.csv or get_default_catalog_symlink(), str(exc)
        ) from exc

    if not csv_path.exists():
        raise _CheckInputError(
            "catalog_csv_missing", csv_path, f"Catalog CSV not found: {csv_path}"
        )

    # Extract timestamp and find matching pipeline files
    ts_catalog = extract_timestamp_from_catalog(csv_path.resolve())
    if ts_catalog:
        return _resolve_timestamped_inputs(args, csv_path, ts_catalog)
    return _resolve_symlink_inputs(args, csv_path)


def _resolve_timestamped_inputs(
    args: argparse.Namespace,
    csv_path: Path,
    ts_catalog: str,
) -> _CheckInputs | _IncompletePipeline:
    catalog_dir = csv_path.resolve().parent
    normalized_candidates = [
        catalog_dir / f"audio_catalog_{ts_catalog}_loudness_normalized.csv",
        catalog_dir / f"audio_catalog_{ts_catalog}_normalized.csv",
    ]
    expected_normalized = next(
        (candidate for candidate in normalized_candidates if candidate.exists()),
        normalized_candidates[-1],
    )
    transcripts_parent = resolve_transcripts_parent()
    base_name = config.paths.transcripts_dir
    expected_transcripts = transcripts_parent / f"{base_name}_{ts_catalog}"
    expected_loudness = catalog_dir / f"audio_catalog_{ts_catalog}_loudness.csv"
    expected_archived = catalog_dir / f"audio_catalog_{ts_catalog}_loudness_archived.csv"

    if not expected_normalized.exists() or not expected_transcripts.exists():
        return _IncompletePipeline(
            csv_path=csv_path,
            timestamp=ts_catalog,
            normalized_path=expected_normalized,
            normalized_symlink=args.csv_normalized or get_default_normalized_symlink(),
            transcripts_path=expected_transcripts,
            loudness_path=expected_loudness,
            archived_path=expected_archived,
        )

    return _CheckInputs(
        csv_path=csv_path,
        csv_normalized_path=expected_normalized,
        transcripts_root=expected_transcripts,
        loudness_path=expected_loudness,
        archived_path=expected_archived,
    )


def _resolve_symlink_inputs(args: argparse.Namespace, csv_path: Path) -> _CheckInputs:
    # No timestamp in catalog name - fall back to symlink resolution
    normalized_symlink = args.csv_normalized or get_default_normalized_symlink()
    csv_normalized_path = (
        normalized_symlink.resolve() if normalized_symlink.exists() else normalized_symlink
    )
    transcripts_root = resolve_transcripts_root()

    if not csv_normalized_path.exists():
        raise _CheckInputError(
            "normalized_csv_missing",
            csv_normalized_path,
            f"Normalized catalog CSV not found: {csv_normalized_path}",
        )
    if not transcripts_root.exists():
        raise _CheckInputError(
            "transcripts_root_missing",
            transcripts_root,
            f"Transcripts root not found: {transcripts_root}",
        )

    return _CheckInputs(
        csv_path=csv_path,
        csv_normalized_path=csv_normalized_path,
        transcripts_root=transcripts_root,
        loudness_path=get_default_loudness_symlink(),
        archived_path=get_default_archived_symlink(),
    )


@dataclass
class _IncompleteReport:
    """What `check` can say about a catalog whose pipeline has not run yet."""

    timestamp: str
    missing: list[str]
    missing_lines: list[str]
    catalog_count: int
    loudness: CheckResult
    archived: CheckResult
    asr_backends: list[str]
    diarization_backends: list[str]


def _missing_artifact_line(label: str, symlink: Path, extract_timestamp) -> str:
    if symlink.exists():
        return f"  {label}not found (symlink → {extract_timestamp(symlink.resolve())})"
    return f"  {label}not found"


def _build_incomplete_report(pipeline: _IncompletePipeline) -> _IncompleteReport:
    # Load catalog to show expected counts
    catalog_hashes = {entry.sha256 for entry in load_catalog_csv(pipeline.csv_path)}

    missing: list[str] = []
    missing_lines: list[str] = []
    if not pipeline.normalized_path.exists():
        missing_lines.append(
            _missing_artifact_line(
                "Normalized:  ",
                pipeline.normalized_symlink,
                extract_timestamp_from_normalized_catalog,
            )
        )
        missing.append("normalized catalog")
    if not pipeline.transcripts_path.exists():
        missing_lines.append(
            _missing_artifact_line(
                "Transcripts: ",
                resolve_transcripts_parent() / config.paths.transcripts_dir,
                extract_timestamp_from_transcripts_root,
            )
        )
        missing.append("transcripts")

    # Check loudness + archive coverage if available
    return _IncompleteReport(
        timestamp=pipeline.timestamp,
        missing=missing,
        missing_lines=missing_lines,
        catalog_count=len(catalog_hashes),
        loudness=CheckResult(
            "loudness_catalog",
            *require_loudness_catalog(pipeline.loudness_path, catalog_hashes),
        ),
        archived=CheckResult(
            "archived_audio",
            *require_archived_audio(pipeline.archived_path, catalog_hashes),
        ),
        asr_backends=expected_asr_backends_from_code(),
        diarization_backends=expected_diarization_backends_from_code(),
    )


def _coverage_issue_info(stats: dict) -> str:
    issue_parts = []
    if stats.get("missing", 0) > 0:
        issue_parts.append(f"missing {stats['missing']}")
    if stats.get("stale", 0) > 0:
        issue_parts.append(f"+{stats['stale']} stale")
    if stats.get("missing_metrics", 0) > 0:
        issue_parts.append(f"missing metrics {stats['missing_metrics']}")
    if stats.get("missing_paths", 0) > 0:
        issue_parts.append(f"missing paths {stats['missing_paths']}")
    if stats.get("missing_files", 0) > 0:
        issue_parts.append(f"missing files {stats['missing_files']}")
    return f" ({', '.join(issue_parts)})" if issue_parts else ""


def _expected_artifact_line(label: str, result: CheckResult, catalog_count: int) -> str:
    """One artifact's coverage line in the incomplete-pipeline report."""

    if result.stats:
        status = "✅" if result.ok else "⚠️"
        total = result.stats.get("total", 0)
        return f"    {status} {label}: {total}/{catalog_count}{_coverage_issue_info(result.stats)}"
    if not result.ok:
        return f"    ❌ {result.message}"
    return "    ✅ OK"


def _zero_coverage_lines(backends: list[str], catalog_count: int) -> list[str]:
    width = max((len(backend) for backend in backends), default=0)
    return [f"    ❌ {backend:<{width}}: 0/{catalog_count}" for backend in backends]


def _incomplete_report_lines(report: _IncompleteReport) -> list[str]:
    count = report.catalog_count
    lines = [f"\nPipeline incomplete for timestamp {report.timestamp}:", *report.missing_lines]

    # Show what would be expected for a complete pipeline (matching complete output format)
    lines.append(f"\n📊 Catalog: {count} audio files")
    lines.append("\n📈 Loudness catalog:")
    lines.append(_expected_artifact_line("loudness", report.loudness, count))
    lines.append("\n📦 Archived audio:")
    lines.append(_expected_artifact_line("archived", report.archived, count))

    # Archived coverage (archived catalog only)
    coverage = _archived_coverage(report.archived)
    if coverage is not None:
        # The warning icon is followed by two spaces here, unlike the complete report.
        icon = "✅" if coverage == count else "⚠️ "
        lines.append(f"\n{icon} Archived coverage (archived catalog): {coverage}/{count}")

    # Transcription backends (format: icon backend: current/expected)
    lines.append("\n📝 Transcription backends coverage:")
    lines.extend(_zero_coverage_lines(report.asr_backends, count))
    lines.append("\n🗣️  Diarization backends coverage:")
    lines.extend(_zero_coverage_lines(report.diarization_backends, count))

    # Derived artifacts
    lines.append("\n📄 Transcript exports:")
    lines.extend(_zero_coverage_lines(report.asr_backends, count))
    lines.append("\n👥 Speaker clusters:")
    lines.extend(_zero_coverage_lines(report.diarization_backends, count))

    lines.append("\nRun the pipeline to generate these files.")
    return lines


def _render_incomplete_report(report: _IncompleteReport, output_format: str) -> None:
    lines = _incomplete_report_lines(report)
    if output_format != "json":
        for line in lines:
            print(line)
        return
    print_json_result(
        name=_COMMAND_NAME,
        status="warning",
        result={
            "timestamp": report.timestamp,
            "missing": report.missing,
            "pipeline_artifacts": {
                "loudness": report.loudness.to_json(),
                "archived": report.archived.to_json(),
                "actionable": {
                    "count": _archived_coverage(report.archived),
                    "expected": report.catalog_count,
                },
            },
            "messages": lines,
        },
    )


@dataclass
class CheckReport:
    """Findings of a complete `catalog check` run, filled in step by step."""

    inputs: _CheckInputs
    verbose: bool
    catalog_hashes: set[str] = field(default_factory=set)
    catalog_count: int = 0
    pipeline_artifacts: list[CheckResult] = field(default_factory=list)
    derived_directories: list[CheckResult] = field(default_factory=list)
    expected_backends: list[str] | None = None
    diarization_backends: list[str] | None = None
    validation: ValidationResult | None = None
    messages: list[str] = field(default_factory=list)

    @property
    def result(self) -> ValidationResult:
        if self.validation is None:
            raise RuntimeError("Catalog validation did not produce a result.")
        return self.validation

    @property
    def archived_coverage(self) -> int | None:
        for check in self.pipeline_artifacts:
            if check.name == "archived_audio":
                return _archived_coverage(check)
        return None

    @property
    def core_issues_detected(self) -> bool:
        # Core pipeline issues (data integrity problems, not pending work)
        # Note: missing_normalized_hashes is NOT an error - it just means files
        # are in the catalog but not yet staged (normal intermediate state)
        result = self.result
        return any(
            [
                result.missing_original_hashes,  # normalized references non-existent catalog entries
                result.normalized_only_hashes,  # normalized has entries not in catalog
                result.staged_files_missing,  # normalized references missing WAV files
                result.orphaned_staged,  # staged files with no catalog entry
                result.orphaned_transcripts,  # transcripts with no catalog entry
                result.orphaned_diarization,  # diarization with no catalog entry
            ]
        )

    @property
    def derived_issues_detected(self) -> bool:
        # Derived artifacts issues (transcript exports, clusters) - warnings, not failures
        return any(check.failed for check in self.derived_directories)

    @property
    def pipeline_artifacts_issues_detected(self) -> bool:
        return any(check.failed for check in self.pipeline_artifacts)

    @property
    def has_stale_files(self) -> bool:
        # Stale ColBERT index rows are removed by `rag-colbert-index` (already
        # suggested via the failed-check remediation), not by `clean --prune-orphans`,
        # which only prunes transcript sidecars.
        for check in self.derived_directories:
            if check.name == "colbert_index" or not check.stats:
                continue
            for s in check.stats.values():
                if isinstance(s, dict) and s.get("stale", 0) > 0:
                    return True
        return False

    @property
    def json_status(self) -> JsonStatus:
        if self.core_issues_detected:
            return "error"
        if self.derived_issues_detected or self.pipeline_artifacts_issues_detected:
            return "warning"
        return "success"


def _load_catalog(report: CheckReport) -> None:
    report.catalog_hashes = {entry.sha256 for entry in load_catalog_csv(report.inputs.csv_path)}
    report.catalog_count = len(report.catalog_hashes)


def _check_loudness_catalog(report: CheckReport) -> None:
    report.pipeline_artifacts.append(
        CheckResult(
            "loudness_catalog",
            *require_loudness_catalog(report.inputs.loudness_path, report.catalog_hashes),
        )
    )


def _check_archived_audio(report: CheckReport) -> None:
    report.pipeline_artifacts.append(
        CheckResult(
            "archived_audio",
            *require_archived_audio(report.inputs.archived_path, report.catalog_hashes),
        )
    )


def _check_transcript_exports(report: CheckReport) -> None:
    report.derived_directories.append(
        CheckResult(
            "transcript_exports",
            *require_transcript_exports(report.inputs.transcripts_root, report.catalog_hashes),
        )
    )


def _check_colbert_bundles(report: CheckReport) -> None:
    report.pipeline_artifacts.append(
        CheckResult("colbert_bundle", *require_colbert_bundles(report.inputs.transcripts_root))
    )


def _check_colbert_hash_coverage(report: CheckReport) -> None:
    report.derived_directories.append(
        CheckResult(
            "colbert_index",
            *require_colbert_hash_coverage(report.inputs.transcripts_root, report.catalog_hashes),
        )
    )


def _check_speaker_clusters(report: CheckReport) -> None:
    transcripts_root = report.inputs.transcripts_root
    # Speaker clusters directory is a sibling to transcripts with matching run_id
    transcripts_resolved = (
        transcripts_root.resolve() if transcripts_root.is_symlink() else transcripts_root
    )
    run_id = extract_run_id_from_transcripts_root(transcripts_resolved)
    if run_id:
        clusters_root = transcripts_root.parent / f"speaker_clusters_{run_id}"
    else:
        clusters_root = transcripts_root.parent / config.paths.speaker_clusters_dir
    report.derived_directories.append(
        CheckResult(
            "speaker_clusters",
            *require_speaker_clusters(transcripts_root, clusters_root, report.catalog_hashes),
        )
    )


def _validate_catalog_chain(report: CheckReport) -> None:
    expected_backends = expected_asr_backends_from_code()
    if not expected_backends:
        report.messages.append(
            "Warning: unable to determine ASR backends from code; skipping backend coverage check."
        )
        expected_backends = None

    diarization_backends = expected_diarization_backends_from_code()
    if not diarization_backends:
        report.messages.append(
            "Warning: unable to determine diarization backends from code; skipping diarization backend coverage check."
        )
        diarization_backends = None

    report.expected_backends = expected_backends
    report.diarization_backends = diarization_backends
    report.validation = validate_catalog(
        report.inputs.csv_path,
        report.inputs.csv_normalized_path,
        report.inputs.transcripts_root,
        expected_backends=expected_backends,
        expected_diarization_backends=diarization_backends,
    )


# Verification steps, in the order they run and appear in the progress bar.
_CHECK_STEPS: list[tuple[str, Callable[[CheckReport], None]]] = [
    ("Loading catalog", _load_catalog),
    ("Checking loudness catalog", _check_loudness_catalog),
    ("Checking archived audio", _check_archived_audio),
    ("Checking transcript export coverage", _check_transcript_exports),
    ("Checking ColBERT bundles", _check_colbert_bundles),
    ("Checking ColBERT hash coverage", _check_colbert_hash_coverage),
    ("Checking speaker clusters", _check_speaker_clusters),
    ("Validating catalog chain", _validate_catalog_chain),
]


def _run_checks(inputs: _CheckInputs, *, verbose: bool, output_format: str) -> CheckReport:
    report = CheckReport(inputs=inputs, verbose=verbose)
    text_output = output_format == "text"
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=Console(),
        transient=True,
        disable=not text_output,
    ) as progress:
        task = progress.add_task("Verifying...", total=len(_CHECK_STEPS))
        for step_name, step in _CHECK_STEPS:
            progress.update(task, description=step_name)
            emitted = len(report.messages)
            step(report)
            if text_output:
                # Warnings print as they arise, above the progress bar.
                for message in report.messages[emitted:]:
                    print(message)
            progress.advance(task)
    return report


def _pipeline_artifact_lines(check: CheckResult, catalog_count: int) -> list[str]:
    spec = _CHECK_SPECS[check.name]
    lines = [f"{spec.emoji}  {spec.title}:"]
    if check.stats:
        status = "✅" if check.ok else "⚠️"
        total = check.stats.get("total", 0)
        expected = check.stats.get("expected", catalog_count)
        lines.append(f"    {status} {total}/{expected}{_coverage_issue_info(check.stats)}")
    elif check.ok is False:
        lines.append(f"    ❌ {check.message}")
    elif check.ok is None:
        lines.append(f"    ℹ️  {check.message}")
    else:
        lines.append("    ✅ OK")
    lines.append("")
    return lines


def _backend_coverage_line(stats: dict, backend: str, width: int, catalog_count: int) -> str:
    padded_name = backend.ljust(width)
    s = stats[backend]
    if isinstance(s, dict):
        total = s.get("total")
        expected = s.get("expected")
        missing = s.get("missing")
        stale = s.get("stale")
        if missing is None and total is not None and expected is not None:
            missing = max(0, expected - total)
        is_ok = (
            missing == 0
            and (stale or 0) == 0
            and total is not None
            and expected is not None
            and total == expected
        )
        status = "✅" if is_ok else "⚠️"
        if missing is None and (total is None or expected is None):
            issue_info = " (stats incomplete)"
        elif missing and missing > 0:
            issue_info = f" (missing {missing})"
        elif stale and stale > 0:
            issue_info = f" (+{stale} stale)"
        elif total is not None and expected is not None and total > expected:
            issue_info = f" (+{total - expected} stale)"
        else:
            issue_info = ""
        total_display = total if total is not None else 0
        expected_display = expected if expected is not None else catalog_count
    else:
        status = "⚠️"
        issue_info = " (stats invalid)"
        total_display = 0
        expected_display = catalog_count
    return f"    {status} {padded_name}: {total_display}/{expected_display}{issue_info}"


def _derived_directory_lines(check: CheckResult, catalog_count: int) -> list[str]:
    spec = _CHECK_SPECS[check.name]
    lines = [f"{spec.emoji}  {spec.title}:"]
    if check.stats:
        # Calculate max backend name length for alignment
        width = max(len(backend) for backend in check.stats.keys())
        lines.extend(
            _backend_coverage_line(check.stats, backend, width, catalog_count)
            for backend in check.stats
        )
    elif check.ok is False:
        lines.append(f"    ⚠️  {check.message}")
    elif check.ok is None:
        lines.append(f"    ℹ️  {check.message}")
    else:
        lines.append("    ✅ OK")
    lines.append("")
    return lines


_PRUNE_LINE = "    Run: just catalog clean --prune-orphans  # Remove stale derived files"


def _final_status_lines(report: CheckReport) -> list[str]:
    if report.core_issues_detected:
        return ["❌ Core pipeline issues detected (see above)"]
    if report.pipeline_artifacts_issues_detected or report.derived_issues_detected:
        # Show specific commands for failed checks
        lines = ["⚠️  Core pipeline OK, but artifacts need regeneration"]
        lines.extend(
            check.remedy_line
            for check in report.pipeline_artifacts + report.derived_directories
            if check.failed
        )
        if report.has_stale_files:
            lines.append(_PRUNE_LINE)
        return lines
    if report.has_stale_files:
        return ["⚠️  Pipeline OK, but stale files detected", _PRUNE_LINE]
    return ["✅ All checks passed!"]


def _render_text_report(report: CheckReport) -> None:
    report_text, _catalog_issues_found = format_validation_report(
        report.result, verbose=report.verbose
    )
    lines = [report_text]

    # Emit pipeline artifact status (loudness + archive)
    for check in report.pipeline_artifacts:
        lines.extend(_pipeline_artifact_lines(check, report.catalog_count))

    # Archived coverage (archived catalog only)
    coverage = report.archived_coverage
    if coverage is not None:
        status = "✅" if coverage == report.catalog_count else "⚠️"
        lines.append(
            f"{status} Archived coverage (archived catalog): {coverage}/{report.catalog_count}"
        )
        lines.append("")

    # Emit derived directories status after catalog report
    for check in report.derived_directories:
        lines.extend(_derived_directory_lines(check, report.catalog_count))

    # Final status at the end
    lines.extend(_final_status_lines(report))
    lines.append("")
    lines.append("=" * 70)
    for line in lines:
        print(line)


def _render_json_report(report: CheckReport) -> None:
    coverage = {"count": report.archived_coverage, "expected": report.catalog_count}
    data = {
        "result": asdict(report.result),
        "core_issues_detected": report.core_issues_detected,
        "derived_issues_detected": report.derived_issues_detected,
        "pipeline_artifacts_issues_detected": report.pipeline_artifacts_issues_detected,
        "derived_directories": {
            check.name: check.to_json() for check in report.derived_directories
        },
        "pipeline_artifacts": {check.name: check.to_json() for check in report.pipeline_artifacts},
        "actionable_coverage": coverage,
        "archived_coverage": coverage,
        "expected_backends_checked": bool(report.expected_backends),
        "expected_diarization_backends_checked": bool(report.diarization_backends),
        "messages": report.messages,
        "verbose": report.verbose,
        "csv": str(report.inputs.csv_path),
        "csv_normalized": str(report.inputs.csv_normalized_path),
        "transcripts_root": str(report.inputs.transcripts_root),
    }
    if report.expected_backends:
        data["expected_backends"] = report.expected_backends
    if report.diarization_backends:
        data["expected_diarization_backends"] = report.diarization_backends
    print_json_result(name=_COMMAND_NAME, status=report.json_status, result=data)


def _render_input_error(error: _CheckInputError, output_format: str) -> None:
    if output_format == "json":
        print_json_result(
            name=_COMMAND_NAME,
            status="error",
            result={
                "error": error.code,
                "path": str(error.path),
                "messages": [error.message],
            },
        )
    else:
        print(error.message)


def handle_check(args: argparse.Namespace) -> int:
    """Validate catalog CSV → staged audio → transcripts → diarization chain."""
    output_format = getattr(args, "format", "text")

    try:
        inputs = _resolve_check_inputs(args)
    except _CheckInputError as error:
        _render_input_error(error, output_format)
        return 1

    if isinstance(inputs, _IncompletePipeline):
        # Pipeline incomplete - report gracefully
        _render_incomplete_report(_build_incomplete_report(inputs), output_format)
        return 0  # Not an error, just incomplete

    report = _run_checks(inputs, verbose=args.verbose, output_format=output_format)
    if output_format == "text":
        _render_text_report(report)
    else:
        _render_json_report(report)

    # Only fail on core pipeline issues, not derived artifacts
    return 1 if report.core_issues_detected else 0
